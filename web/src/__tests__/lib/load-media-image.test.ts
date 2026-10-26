// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("@/lib/file-access", () => ({ resolveMediaUrl: mocks.resolve }));

import { loadMediaImage } from "@/lib/load-media-image";

/** 每个地址的加载结果：默认成功，用例按 URL 脚本化失败 */
let outcome: (url: string) => "ok" | "fail";
const loaded: string[] = [];
const originalImage = window.Image;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  #src = "";

  get src() {
    return this.#src;
  }

  set src(value: string) {
    this.#src = value;
    loaded.push(value);
    queueMicrotask(() => {
      if (outcome(value) === "ok") this.onload?.();
      else this.onerror?.();
    });
  }
}

function signed(url: string) {
  return { url, delivery: "signed" as const };
}

beforeEach(() => {
  mocks.resolve.mockReset();
  loaded.length = 0;
  outcome = () => "ok";
  Object.defineProperty(window, "Image", { configurable: true, value: FakeImage });
});

afterEach(() => {
  Object.defineProperty(window, "Image", { configurable: true, value: originalImage });
});

describe("loadMediaImage", () => {
  it("动作时解析地址并以跨域凭据模式加载", async () => {
    mocks.resolve.mockResolvedValue(signed("https://cdn.example/a.png"));

    const img = await loadMediaImage("key.png");

    expect(mocks.resolve).toHaveBeenCalledWith("key.png");
    expect(loaded).toEqual(["https://cdn.example/a.png"]);
    expect(img.crossOrigin).toBe("anonymous");
  });

  it("signed 元素加载失败 → 强制刷新一次并重载（规则 3.6）", async () => {
    mocks.resolve
      .mockResolvedValueOnce(signed("https://cdn.example/expired.png"))
      .mockResolvedValueOnce(signed("https://cdn.example/fresh.png"));
    outcome = (url) => (url.endsWith("fresh.png") ? "ok" : "fail");

    const img = await loadMediaImage("key.png");

    expect(mocks.resolve).toHaveBeenLastCalledWith("key.png", { forceRefresh: true });
    expect(img.src).toBe("https://cdn.example/fresh.png");
    expect(loaded).toEqual(["https://cdn.example/expired.png", "https://cdn.example/fresh.png"]);
  });

  it("stream 地址失败不重新描述：重解析不可能换地址，直接上抛", async () => {
    mocks.resolve.mockResolvedValue({ url: "/api/files/key.png", delivery: "stream" });
    outcome = () => "fail";

    await expect(loadMediaImage("key.png")).rejects.toThrow("media image load failed");
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual(["/api/files/key.png"]);
  });

  it("外部地址失败同样不重新描述（与元素形态一致）", async () => {
    mocks.resolve.mockResolvedValue({ url: "https://cdn.example/a.png" });
    outcome = () => "fail";

    await expect(loadMediaImage("https://cdn.example/a.png")).rejects.toThrow("media image load failed");
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(loaded).toHaveLength(1);
  });

  it("描述本身失败不触发强制刷新，直接上抛", async () => {
    mocks.resolve.mockRejectedValue(new Error("descriptor down"));

    await expect(loadMediaImage("key.png")).rejects.toThrow("descriptor down");
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual([]);
  });

  it("刷新后仍失败则上抛，不无限重试", async () => {
    mocks.resolve
      .mockResolvedValueOnce(signed("https://cdn.example/a.png"))
      .mockResolvedValueOnce(signed("https://cdn.example/b.png"));
    outcome = () => "fail";

    await expect(loadMediaImage("key.png")).rejects.toThrow("media image load failed");
    expect(loaded).toHaveLength(2);
  });
});
