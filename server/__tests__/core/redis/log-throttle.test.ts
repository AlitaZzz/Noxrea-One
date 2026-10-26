import { afterEach, describe, expect, it, vi } from "vitest";

import { REDIS_FAILURE_LOG_INTERVAL_MS } from "@server/core/redis/constants";
import { createFailureLogThrottle } from "@server/core/redis/log-throttle";

afterEach(() => {
  vi.useRealTimers();
});

describe("createFailureLogThrottle", () => {
  it("同一实例在间隔内只放行一次，间隔到达后再次放行", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const shouldLog = createFailureLogThrottle();

    expect(shouldLog()).toBe(true);
    expect(shouldLog()).toBe(false);

    vi.setSystemTime(REDIS_FAILURE_LOG_INTERVAL_MS - 1);
    expect(shouldLog()).toBe(false);

    vi.setSystemTime(REDIS_FAILURE_LOG_INTERVAL_MS);
    expect(shouldLog()).toBe(true);
    expect(shouldLog()).toBe(false);
  });

  it("不同实例各自计时，互不影响", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = createFailureLogThrottle();
    const second = createFailureLogThrottle();

    expect(first()).toBe(true);
    expect(second()).toBe(true);
  });
});
