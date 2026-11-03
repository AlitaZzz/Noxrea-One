/**
 * 代理提示判定（specs/client-video-editing.md）：两个面板共用同一份状态映射，
 * 不可播放时必须给出说明；只有带错误码的失败才有重试入口。
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { demoteRetryNotice, proxyNoticeOf } from "@/features/canvas/editing/ProxyNotice";

const ERROR = { code: "media.busy", retryAfterSeconds: 3, receivedAt: 1 };

describe("proxyNoticeOf", () => {
  it("可播放时没有提示", () => {
    expect(proxyNoticeOf({ status: "ready", url: "http://test/proxy.mp4", playable: true, error: null }))
      .toBeNull();
  });

  it("请求中提示加载", () => {
    expect(proxyNoticeOf({ status: "pending", url: null, playable: false, error: null }))
      .toEqual({ kind: "text", key: "clip.proxyLoading" });
  });

  it("可下载但浏览器未缓冲提示缓冲", () => {
    expect(proxyNoticeOf({ status: "ready", url: "http://test/proxy.mp4", playable: false, error: null }))
      .toEqual({ kind: "text", key: "clip.buffering" });
  });

  it("无代理可用（非 key 源）如实显示不可用，而不是永远停在缓冲中", () => {
    expect(proxyNoticeOf({ status: "ready", url: null, playable: false, error: null }))
      .toEqual({ kind: "text", key: "clip.proxyUnavailable" });
  });

  it("失败且无错误码（浏览器解不出来）：只给文字，重试同一产物无意义", () => {
    expect(proxyNoticeOf({ status: "failed", url: "http://test/proxy.mp4", playable: false, error: null }))
      .toEqual({ kind: "text", key: "clip.proxyUnavailable" });
  });

  it("失败且带错误码（限流 / 繁忙）：给出可重试原因", () => {
    expect(proxyNoticeOf({ status: "failed", url: null, playable: false, error: ERROR }))
      .toEqual({ kind: "retry", error: ERROR });
  });
});

describe("demoteRetryNotice", () => {
  it("中央提示把可重试失败降为文字，重试按钮留给底部原因条", () => {
    expect(demoteRetryNotice({ kind: "retry", error: ERROR }))
      .toEqual({ kind: "text", key: "clip.proxyUnavailable" });
    const text = { kind: "text", key: "clip.buffering" } as const;
    expect(demoteRetryNotice(text)).toBe(text);
    expect(demoteRetryNotice(null)).toBeNull();
  });
});
