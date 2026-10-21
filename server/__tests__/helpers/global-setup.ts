/**
 * Vitest 全局 setup（specs/pglite-removal.md）：
 * - TEST_DATABASE_URL 未设置：非 CI 跳过真实库用例；CI 直接失败（禁止用跳过掩盖覆盖缺失）。
 * - 已设置：先做安全校验，再显式以 DATABASE_URL=TEST_DATABASE_URL 执行一次
 *   `prisma migrate deploy`（Prisma 7 CLI 不自动加载 .env）。
 */
import { runPrisma } from "../../../scripts/lib/prisma-cli.mts";
import { assertSafeTestDatabaseUrl } from "./test-database";

function isCi(): boolean {
  return process.env.CI === "true" || process.env.CI === "1";
}

export default function setup(): void {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    if (isCi()) {
      throw new Error(
        "CI 环境必须配置 TEST_DATABASE_URL（专用测试库，库名需包含 test），真实数据库用例不允许静默跳过。",
      );
    }
    console.warn("[test] TEST_DATABASE_URL 未设置：真实数据库用例将整体跳过。");
    return;
  }

  assertSafeTestDatabaseUrl(testUrl, process.env.DATABASE_URL);
  runPrisma(["migrate", "deploy"], { ...process.env, DATABASE_URL: testUrl });
}
