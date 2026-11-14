/**
 * 测试库连接串的 statement_timeout 注入。
 *
 * 覆盖根因：客户端超时不会取消已发往 PostgreSQL 的语句，超时语句会继续持锁，
 * 让后续测试文件卡在文件级 advisory lock 上连锁失败。helper 给测试库连接附加
 * 服务端 statement_timeout，并保留调用方已有的查询参数与 options。
 */
import { describe, expect, it } from "vitest";

import { withStatementTimeout } from "./test-database";

describe("withStatementTimeout", () => {
  it("默认 90s 上限（低于 Vitest 120s）且连接目标不变", () => {
    const url = withStatementTimeout("postgres://u:p@localhost:5432/noxrea_test");
    const parsed = new URL(url);

    expect(parsed.searchParams.get("options")).toBe("-c statement_timeout=90000");
    expect(`${parsed.host}${parsed.pathname}`).toBe("localhost:5432/noxrea_test");
  });

  it("保留已有查询参数并合并现有 options", () => {
    const url = withStatementTimeout(
      "postgres://u:p@localhost:5432/noxrea_test?schema=public&options=-c%20application_name%3Dvitest",
      90_000,
    );
    const parsed = new URL(url);

    expect(parsed.searchParams.get("schema")).toBe("public");
    expect(parsed.searchParams.get("options")).toBe(
      "-c application_name=vitest -c statement_timeout=90000",
    );
  });
});
