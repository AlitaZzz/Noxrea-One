/**
 * 主动刷新调度（specs/storage-signed-direct-delivery.md 规则 3.8）：
 * 抖动范围、兜底时刻、失效安全线与后台退避。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  backgroundRetryAt,
  proactiveRefreshAt,
  resetProactiveRefresh,
  scheduleProactiveRefresh,
} from "@/lib/file-access/proactive";

const EXPIRES = 3600;
const REFRESH = 2880;

describe("proactiveRefreshAt", () => {
  it("抖动按 refreshAt→expiresAt 余量缩放：寿命 70% / 80% / 90%", () => {
    expect(proactiveRefreshAt({ expiresAt: EXPIRES, refreshAt: REFRESH }, 0, -1)).toBe(2520_000);
    expect(proactiveRefreshAt({ expiresAt: EXPIRES, refreshAt: REFRESH }, 0, 0)).toBe(2880_000);
    expect(proactiveRefreshAt({ expiresAt: EXPIRES, refreshAt: REFRESH }, 0, 1)).toBe(3240_000);
  });

  it("缺少 refreshAt 时按失效前 60s 兜底，并保留 ±30s 抖动", () => {
    expect(proactiveRefreshAt({ expiresAt: EXPIRES }, 0, -1)).toBe(3510_000);
    expect(proactiveRefreshAt({ expiresAt: EXPIRES }, 0, 0)).toBe(3540_000);
    expect(proactiveRefreshAt({ expiresAt: EXPIRES }, 0, 1)).toBe(3570_000);
  });

  it("已过建议时刻立即刷新，临近失效返回 null", () => {
    expect(proactiveRefreshAt({ expiresAt: EXPIRES, refreshAt: REFRESH }, 3000_000, 0)).toBe(3000_000);
    expect(proactiveRefreshAt({ expiresAt: EXPIRES, refreshAt: REFRESH }, 3596_000, 0)).toBeNull();
  });

  it("不晚于失效前 5s", () => {
    expect(proactiveRefreshAt({ expiresAt: EXPIRES, refreshAt: 3599 }, 0, 0)).toBe(3595_000);
  });
});

describe("共享调度", () => {
  afterEach(() => {
    resetProactiveRefresh();
    vi.useRealTimers();
  });

  it("取消最早项后，剩余项仍由共享定时器触发", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = vi.fn();
    const second = vi.fn();
    const cancelFirst = scheduleProactiveRefresh(1_000, first);
    scheduleProactiveRefresh(2_000, second);

    cancelFirst();
    // 旧定时器在 1s 触发时没有到期项；必须重排到剩余项的 2s，而不是就此搁浅
    vi.advanceTimersByTime(1_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("backgroundRetryAt", () => {
  it("30s 起指数退避，5min 封顶", () => {
    expect(backgroundRetryAt(EXPIRES, 1, 0)).toBe(30_000);
    expect(backgroundRetryAt(EXPIRES, 2, 0)).toBe(60_000);
    expect(backgroundRetryAt(EXPIRES, 3, 0)).toBe(120_000);
    expect(backgroundRetryAt(EXPIRES, 10, 0)).toBe(300_000);
  });

  it("不超过失效前安全线", () => {
    expect(backgroundRetryAt(EXPIRES, 1, 3_590_000)).toBe(3_595_000);
  });

  it("已经临近失效返回 null", () => {
    expect(backgroundRetryAt(EXPIRES, 1, 3_596_000)).toBeNull();
  });
});
