// @vitest-environment jsdom
/**
 * 统一下载触发（specs/storage-signed-direct-delivery.md 规则 2.6 / 3.5）：
 * signed 由服务端签入 disposition，stream 在同源 URL 上带 download/filename，
 * 外部 URL 直链；解析失败给出轻量消息且不触发下载（web/AGENTS.md 七.1：
 * 用户点击的即时反馈用消息，不用通知）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  message: vi.fn(),
}));

// 下载是「需要最终地址的非元素形态」：它必须使用带一次性重试的入口（规则 3.6）
vi.mock("@/lib/file-access", () => ({ resolveMediaUrlWithRetry: mocks.resolve }));
vi.mock("@/lib/global-message", () => ({
  showGlobalMessage: () => ({ error: mocks.message }),
}));
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key } }));

import { downloadManagedFile } from "@/lib/utils/download";

const KEY = "9/ab/" + "a".repeat(64) + ".png";

let clicked: HTMLAnchorElement | null = null;
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.message.mockReset();
  clicked = null;
  const create = document.createElement.bind(document);
  spies.push(
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === "a") clicked = element as HTMLAnchorElement;
      return element;
    }) as typeof document.createElement),
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("downloadManagedFile", () => {
  it("signed：使用预签名 URL，文件名交给服务端 disposition（不设 download 属性）", async () => {
    mocks.resolve.mockResolvedValue({ url: "https://signed.example/object", delivery: "signed" });

    await downloadManagedFile(KEY, "cover.png");

    expect(mocks.resolve).toHaveBeenCalledWith(`/api/files/${KEY}`, {
      download: true,
      filename: "cover.png",
    });
    expect(clicked?.getAttribute("href")).toBe("https://signed.example/object");
    expect(clicked?.hasAttribute("download")).toBe(false);
  });

  it("stream：同源 URL 携带 download/filename，并设置 download 属性", async () => {
    mocks.resolve.mockResolvedValue({
      url: `/api/files/${KEY}?download=1&filename=cover.png`,
      delivery: "stream",
    });

    await downloadManagedFile(KEY, "cover.png");

    expect(clicked?.getAttribute("href")).toBe(`/api/files/${KEY}?download=1&filename=cover.png`);
    expect(clicked?.getAttribute("download")).toBe("cover.png");
  });

  it("外部 URL 由解析层原样返回，不追加下载参数", async () => {
    mocks.resolve.mockResolvedValue({ url: "https://cdn.example.com/a.png" });

    await downloadManagedFile("https://cdn.example.com/a.png", "a.png");

    expect(clicked?.getAttribute("href")).toBe("https://cdn.example.com/a.png");
    expect(clicked?.getAttribute("download")).toBe("a.png");
  });

  it("描述失败：轻量消息提示错误，不触发下载", async () => {
    mocks.resolve.mockRejectedValue(new Error("boom"));

    await downloadManagedFile(KEY, "cover.png");

    expect(clicked).toBeNull();
    // 用户点击的即时反馈：消息条就够，不需要展开原因的持久通知
    expect(mocks.message).toHaveBeenCalledWith("common.downloadFailed");
  });
});
