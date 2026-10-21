import { afterEach, describe, expect, it, vi } from "vitest";

import { databasePoolMax } from "@server/core/database/pool";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("databasePoolMax（每进程连接池上限）", () => {
  it("未设置或空串时取默认值 10", () => {
    vi.stubEnv("DATABASE_POOL_MAX", undefined);
    expect(databasePoolMax()).toBe(10);
    vi.stubEnv("DATABASE_POOL_MAX", "");
    expect(databasePoolMax()).toBe(10);
  });

  it.each(["1", "10", "25"])("接受正整数 %s", (value) => {
    vi.stubEnv("DATABASE_POOL_MAX", value);
    expect(databasePoolMax()).toBe(Number(value));
  });

  it.each(["0", "-1", "1.5", "abc", " 10 ", "Infinity", "1e2", "9007199254740992"])(
    "拒绝非法值 %s",
    (value) => {
      vi.stubEnv("DATABASE_POOL_MAX", value);
      expect(() => databasePoolMax()).toThrow(/DATABASE_POOL_MAX/);
    },
  );
});
