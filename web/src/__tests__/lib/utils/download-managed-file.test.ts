// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.example/"}
/**
 * 统一下载触发（specs/storage-signed-direct-delivery.md 规则 3.9）：
 * 下载不得以顶层文档导航触发。signed 走一次性隐藏 iframe（即使 URL 恰好同源），
 * 同源 / blob: / data: 走 `<a download>`（download 属性一律设置，空串也设置），
 * 外部跨域走新标签；危险 scheme 与解析失败按 3.7 给轻量消息且不触发下载。
 * 页面固定为 https://app.example：混合内容与 origin 判定依赖页面来源。
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

let anchors: HTMLAnchorElement[] = [];
let frames: HTMLIFrameElement[] = [];
let frameSrcAtAppend: boolean | null = null;
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.message.mockReset();
  anchors = [];
  frames = [];
  frameSrcAtAppend = null;
  const create = document.createElement.bind(document);
  const append = document.body.appendChild.bind(document.body);
  spies.push(
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === "a") anchors.push(element as HTMLAnchorElement);
      if (tag === "iframe") frames.push(element as HTMLIFrameElement);
      return element;
    }) as typeof document.createElement),
    vi.spyOn(document.body, "appendChild").mockImplementation(((node: Node) => {
      if (node instanceof HTMLIFrameElement) frameSrcAtAppend = node.hasAttribute("src");
      return append(node);
    }) as typeof document.body.appendChild),
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("downloadManagedFile", () => {
  it("signed：使用隐藏 iframe，不创建锚点", async () => {
    mocks.resolve.mockResolvedValue({ url: "https://storage.example/object", delivery: "signed" });

    await downloadManagedFile(KEY, "cover.png");

    expect(mocks.resolve).toHaveBeenCalledWith(`/api/files/${KEY}`, {
      download: true,
      filename: "cover.png",
    });
    expect(anchors).toHaveLength(0);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.getAttribute("src")).toBe("https://storage.example/object");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.getAttribute("tabindex")).toBe("-1");
    expect(frame.getAttribute("title")).toBeTruthy();
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.style.position).toBe("absolute");
    expect(frame.style.left).toBe("-9999px");
    expect(frame.style.width).toBe("0px");
    expect(frame.style.height).toBe("0px");
    // sandbox 会连带限制下载，规则 3.9 明确不设
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(document.body.contains(frame)).toBe(true);
    // 先挂载再赋 src：挂载时尚未设置 src
    expect(frameSrcAtAppend).toBe(false);
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("signed 且 URL 恰好同源：仍走 iframe（先看 delivery）", async () => {
    mocks.resolve.mockResolvedValue({
      url: "https://app.example/api/files/x?sign=1",
      delivery: "signed",
    });

    await downloadManagedFile(KEY, "cover.png");

    expect(frames).toHaveLength(1);
    expect(anchors).toHaveLength(0);
    expect(frames[0]!.getAttribute("src")).toBe("https://app.example/api/files/x?sign=1");
  });

  it("signed 混合内容：https 页面 + http 签名 URL 退回新标签", async () => {
    mocks.resolve.mockResolvedValue({ url: "http://storage.example/object", delivery: "signed" });

    await downloadManagedFile(KEY, "cover.png");

    expect(frames).toHaveLength(0);
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.getAttribute("href")).toBe("http://storage.example/object");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor.hasAttribute("download")).toBe(false);
  });

  it("stream：同源 URL 用锚点并设置文件名", async () => {
    mocks.resolve.mockResolvedValue({
      url: `/api/files/${KEY}?download=1&filename=cover.png`,
      delivery: "stream",
    });

    await downloadManagedFile(KEY, "cover.png");

    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.getAttribute("href")).toBe(
      `https://app.example/api/files/${KEY}?download=1&filename=cover.png`,
    );
    expect(anchor.getAttribute("download")).toBe("cover.png");
    expect(anchor.hasAttribute("target")).toBe(false);
  });

  it("stream 且调用方未提供文件名：download 属性为空串仍然设置", async () => {
    mocks.resolve.mockResolvedValue({
      url: `/api/files/${KEY}?download=1`,
      delivery: "stream",
    });

    await downloadManagedFile(KEY);

    expect(mocks.resolve).toHaveBeenCalledWith(`/api/files/${KEY}`, { download: true });
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.hasAttribute("download")).toBe(true);
    expect(anchor.getAttribute("download")).toBe("");
  });

  it("stream 但地址跨域：退回新标签，不交给同标签锚点", async () => {
    mocks.resolve.mockResolvedValue({
      url: "https://cdn.example.com/file?download=1&filename=cover.png",
      delivery: "stream",
    });

    await downloadManagedFile(KEY, "cover.png");

    expect(frames).toHaveLength(0);
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.getAttribute("href")).toBe(
      "https://cdn.example.com/file?download=1&filename=cover.png",
    );
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor.hasAttribute("download")).toBe(false);
  });

  it("无 delivery 的同源 URL：锚点 + download", async () => {
    mocks.resolve.mockResolvedValue({ url: "https://app.example/exports/a.png" });

    await downloadManagedFile("https://app.example/exports/a.png", "a.png");

    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.getAttribute("download")).toBe("a.png");
    expect(anchor.hasAttribute("target")).toBe(false);
  });

  it("外部跨域 URL：新标签打开，不设 download 属性", async () => {
    mocks.resolve.mockResolvedValue({ url: "https://cdn.example.com/a.png" });

    await downloadManagedFile("https://cdn.example.com/a.png", "a.png");

    // 非托管值原样交给解析层，不得被改写
    expect(mocks.resolve).toHaveBeenCalledWith("https://cdn.example.com/a.png", {
      download: true,
      filename: "a.png",
    });
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.getAttribute("href")).toBe("https://cdn.example.com/a.png");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor.hasAttribute("download")).toBe(false);
  });

  it("blob: / data:：原样使用并设置 download", async () => {
    mocks.resolve.mockResolvedValueOnce({ url: "blob:https://app.example/abc" });
    await downloadManagedFile("blob:https://app.example/abc", "a.bin");
    mocks.resolve.mockResolvedValueOnce({ url: "data:text/plain,hello%20world" });
    await downloadManagedFile("data:text/plain,hello%20world", "a.txt");

    expect(anchors).toHaveLength(2);
    expect(anchors[0]!.getAttribute("href")).toBe("blob:https://app.example/abc");
    expect(anchors[0]!.getAttribute("download")).toBe("a.bin");
    expect(anchors[1]!.getAttribute("href")).toBe("data:text/plain,hello%20world");
    expect(anchors[1]!.getAttribute("download")).toBe("a.txt");
    expect(frames).toHaveLength(0);
  });

  it("危险 scheme：不触发下载，按失败提示", async () => {
    mocks.resolve.mockResolvedValue({ url: "javascript:alert(1)" });
    await downloadManagedFile("javascript:alert(1)", "x");
    expect(anchors).toHaveLength(0);
    expect(frames).toHaveLength(0);
    expect(mocks.message).toHaveBeenCalledWith("common.downloadFailed");

    mocks.message.mockClear();
    mocks.resolve.mockResolvedValue({ url: "file:///etc/passwd" });
    await downloadManagedFile("file:///etc/passwd", "x");
    expect(anchors).toHaveLength(0);
    expect(frames).toHaveLength(0);
    expect(mocks.message).toHaveBeenCalledWith("common.downloadFailed");
  });

  it("地址无法解析：按失败提示，不触发任何导航", async () => {
    mocks.resolve.mockResolvedValue({ url: "http://[" });

    await downloadManagedFile(KEY, "cover.png");

    expect(anchors).toHaveLength(0);
    expect(frames).toHaveLength(0);
    expect(mocks.message).toHaveBeenCalledWith("common.downloadFailed");
  });

  it("描述失败：轻量消息提示错误，不触发下载", async () => {
    mocks.resolve.mockRejectedValue(new Error("boom"));

    await downloadManagedFile(KEY, "cover.png");

    expect(anchors).toHaveLength(0);
    expect(frames).toHaveLength(0);
    // 用户点击的即时反馈：消息条就够，不需要展开原因的持久通知
    expect(mocks.message).toHaveBeenCalledWith("common.downloadFailed");
  });

  it("iframe 在固定 60s 后移除，pagehide 时统一清理", async () => {
    vi.useFakeTimers();
    try {
      mocks.resolve.mockResolvedValue({ url: "https://storage.example/object", delivery: "signed" });
      await downloadManagedFile(KEY, "cover.png");
      const first = frames[0]!;
      expect(document.body.contains(first)).toBe(true);
      vi.advanceTimersByTime(59_999);
      expect(document.body.contains(first)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(document.body.contains(first)).toBe(false);

      mocks.resolve.mockResolvedValue({ url: "https://storage.example/other", delivery: "signed" });
      await downloadManagedFile(KEY, "cover.png");
      const second = frames[1]!;
      expect(document.body.contains(second)).toBe(true);
      window.dispatchEvent(new Event("pagehide"));
      expect(document.body.contains(second)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
