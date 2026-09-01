/**
 * 上传传输层（XHR）的失败语义测试。
 *
 * 核心回归点：浏览器不会为「已发出但尚未响应」的 XHR 主动报错，
 * 断网后若只依赖超时兜底，用户会长时间停在「进度条走完却没图」的状态。
 * 因此必须监听 offline 事件立即中止，并以可重试的「离线」错误失败。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiUploadWithProgress, UploadTransportError } from "@/lib/api/client";

vi.mock("@/lib/i18n/config", () => ({ default: { t: (k: string) => k } }));

type Listener = () => void;

class MockXHR {
  static last: MockXHR | null = null;
  status = 0;
  responseText = "";
  sent = false;
  aborted = false;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void; onload?: Listener } = {};
  onload: Listener | null = null;
  onerror: Listener | null = null;
  onabort: Listener | null = null;

  constructor() {
    MockXHR.last = this;
  }
  open() {}
  setRequestHeader() {}
  send() { this.sent = true; }
  abort() { this.aborted = true; this.onabort?.(); }
}

describe("apiUploadWithProgress 的失败语义", () => {
  const listeners: Record<string, Listener[]> = {};

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    MockXHR.last = null;
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
      removeEventListener: (type: string, fn: Listener) => {
        listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("断网时立即中止请求并以可重试的离线错误失败，而非等待超时", async () => {
    const promise = apiUploadWithProgress("/api/files/upload", new FormData());
    const xhr = MockXHR.last!;

    // 模拟：请求体已发完，正在等待服务端响应（此时断网浏览器不会主动报错）
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    xhr.upload.onload?.();
    expect(xhr.aborted).toBe(false);

    listeners.offline?.forEach((fn) => fn());

    expect(xhr.aborted).toBe(true);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadTransportError);
    expect((err as UploadTransportError).kind).toBe("network");
    expect((err as UploadTransportError).retryable).toBe(true);
  });

  it("请求完成后注销 offline 监听，避免残留", async () => {
    const promise = apiUploadWithProgress("/api/files/upload", new FormData());
    const xhr = MockXHR.last!;

    expect(listeners.offline?.length).toBe(1);
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ code: 200, data: { url: "u", key: "k" }, msg: "" });
    xhr.onload?.();

    await expect(promise).resolves.toEqual({ code: 200, data: { url: "u", key: "k" }, msg: "" });
    expect(listeners.offline?.length).toBe(0);
  });
});
