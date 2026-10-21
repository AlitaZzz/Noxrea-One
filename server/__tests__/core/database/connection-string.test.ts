import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertDatabaseUrl,
  assertDistinctDatabaseTargets,
  describeDatabaseTarget,
  isSameDatabaseTarget,
  parsePostgresDatabaseTarget,
} from "@server/core/database/connection-string";

import { assertSafeTestDatabaseUrl } from "../../helpers/test-database";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertDatabaseUrl（单一 PostgreSQL 运行时）", () => {
  it.each([
    "postgres://user:pass@localhost:5432/db",
    "postgresql://user:pass@localhost:5432/db",
  ])("接受 %s", (url) => {
    vi.stubEnv("DATABASE_URL", url);
    expect(assertDatabaseUrl()).toBe(url);
  });

  it.each([
    ["未设置", undefined],
    ["空串", ""],
    ["file: 本地模式", "file:data/pglite"],
    ["其他协议", "http://localhost/db"],
    ["不可解析", "postgres://"],
  ])("拒绝 %s", (_label, url) => {
    vi.stubEnv("DATABASE_URL", url);
    expect(() => assertDatabaseUrl()).toThrow(/DATABASE_URL/);
  });

  it("启动日志目标不包含密码", () => {
    expect(describeDatabaseTarget("postgres://user:secret@host:5432/db")).toBe("pg user@host:5432/db");
  });

  it.each([
    ["非 postgres 协议", "file:data/pglite"],
    ["不可解析", "postgres://"],
    ["缺少数据库名", "postgres://host:5432/"],
  ])("describeDatabaseTarget 拒绝未校验输入：%s", (_label, url) => {
    expect(() => describeDatabaseTarget(url)).toThrow(/数据库连接串/);
  });
});

describe("同库判定（shadow / 测试库共用）", () => {
  it("忽略协议写法、查询参数与默认端口差异", () => {
    expect(
      isSameDatabaseTarget(
        parsePostgresDatabaseTarget("postgres://u:p@db.example:5432/noxrea?schema=public"),
        parsePostgresDatabaseTarget("postgresql://u:p@db.example/noxrea"),
      ),
    ).toBe(true);
  });

  it("库名或端口不同即不是同一个库", () => {
    const base = parsePostgresDatabaseTarget("postgres://u:p@db.example:5432/noxrea");
    expect(
      isSameDatabaseTarget(
        base,
        parsePostgresDatabaseTarget("postgres://u:p@db.example:5432/noxrea_test"),
      ),
    ).toBe(false);
    expect(
      isSameDatabaseTarget(
        base,
        parsePostgresDatabaseTarget("postgres://u:p@db.example:5433/noxrea"),
      ),
    ).toBe(false);
  });

  it("数据库名包含非法 URL 编码时给出可行动错误", () => {
    expect(() => parsePostgresDatabaseTarget("postgres://u:p@db.example:5432/db%zz")).toThrow(
      /非法 URL 编码/,
    );
  });
});

describe("assertDistinctDatabaseTargets（shadow / 测试库共用守卫）", () => {
  it("同库时抛错，包含目标与后果说明", () => {
    expect(() =>
      assertDistinctDatabaseTargets(
        { url: "postgres://u:p@db.example:5432/noxrea_test", label: "第一连接串" },
        { url: "postgresql://u:p@db.example/noxrea_test?schema=public", label: "第二连接串" },
        "会被清空。",
      ),
    ).toThrow(
      /第一连接串 与 第二连接串 指向同一个数据库（db\.example:5432\/noxrea_test）：会被清空。/,
    );
  });

  it("不同库时通过", () => {
    expect(() =>
      assertDistinctDatabaseTargets(
        { url: "postgres://u:p@db.example:5432/noxrea_shadow", label: "SHADOW_DATABASE_URL" },
        { url: "postgres://u:p@db.example:5432/noxrea", label: "DATABASE_URL" },
        "会被清空。",
      ),
    ).not.toThrow();
  });

  it("任一不是 postgres 连接串时跳过（缺失/非法语义由调用方负责）", () => {
    expect(() =>
      assertDistinctDatabaseTargets(
        { url: "postgres://u:p@db.example:5432/noxrea", label: "A" },
        { url: "file:data/pglite", label: "B" },
        "会被清空。",
      ),
    ).not.toThrow();
  });
});

describe("assertSafeTestDatabaseUrl（测试库安全校验）", () => {
  it("库名含 test 且与 DATABASE_URL 不同库时通过", () => {
    expect(
      assertSafeTestDatabaseUrl(
        "postgres://u:p@db.example:5432/noxrea_test",
        "postgres://u:p@db.example:5432/noxrea",
      ),
    ).toMatchObject({ database: "noxrea_test" });
  });

  it("与 DATABASE_URL 指向同一 host/port/database 时拒绝（忽略查询参数差异）", () => {
    expect(() =>
      assertSafeTestDatabaseUrl(
        "postgres://u:p@db.example:5432/noxrea_test?schema=public",
        "postgres://u:p@db.example:5432/noxrea_test?connection_limit=5",
      ),
    ).toThrow(/同一个数据库/);
  });

  it("库名不含 test 时拒绝", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgres://u:p@db.example:5432/noxrea", undefined),
    ).toThrow(/必须包含 "test"/);
  });

  it("非 PostgreSQL URL 时拒绝", () => {
    expect(() => assertSafeTestDatabaseUrl("file:data/pglite", undefined)).toThrow(/postgres/);
  });
});
