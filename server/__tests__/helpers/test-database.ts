/**
 * 真实 PostgreSQL 测试基座（specs/pglite-removal.md）。
 *
 * - 门控：TEST_DATABASE_URL 未设置时非 CI 整体跳过；CI=true/1 时由 global-setup 直接失败。
 * - 安全：库名必须包含 test，且不得与 DATABASE_URL 指向同一个 host/port/database；
 *   校验先于 migrate deploy 与任何 TRUNCATE。
 * - 隔离：会话级 advisory lock（独立连接持锁至文件结束）+ 文件开始前
 *   TRUNCATE ... RESTART IDENTITY CASCADE（排除 _prisma_migrations）。
 * - 连接：应用侧 Prisma 仍读 DATABASE_URL，helper 在文件期间临时指向测试库并在结束时恢复。
 */
import { Client } from "pg";

import {
  assertDistinctDatabaseTargets,
  parsePostgresDatabaseTarget,
  type DatabaseTarget,
} from "../../core/database/connection-string";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const databaseTestsEnabled = Boolean(testDatabaseUrl);

const LOCK_NAMESPACE = "noxrea-test-db:";

/** 恢复 helper 临时改写的环境变量；undefined 表示原本未设置。 */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * 测试库安全校验：库名必须包含 test，且不得与 DATABASE_URL 指向同一个库。
 * global-setup（迁移部署前）与文件级 helper（清理前）都会调用。
 * DATABASE_URL 未设置或不是 postgres 连接串时没有可保护的应用库，仅保留库名规则。
 */
export function assertSafeTestDatabaseUrl(testUrl: string, appUrl: string | undefined): DatabaseTarget {
  const test = parsePostgresDatabaseTarget(testUrl, "TEST_DATABASE_URL");
  if (!test.database.toLowerCase().includes("test")) {
    throw new Error(`TEST_DATABASE_URL 的数据库名必须包含 "test"（当前为 ${test.database}）。`);
  }
  assertDistinctDatabaseTargets(
    { url: testUrl, label: "TEST_DATABASE_URL" },
    { url: appUrl ?? "", label: "DATABASE_URL" },
    "测试会清空表，可能删除业务数据。",
  );
  return test;
}

// pg 只读取自身支持的连接参数（host/port/ssl/options 等）；Prisma 专用的
// schema / connection_limit / pool_timeout 会被忽略，因此无需改写连接串。
async function truncatePublicTables(client: Client): Promise<void> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> '_prisma_migrations'
      ORDER BY table_name`,
  );
  if (rows.length === 0) {
    throw new Error("测试库没有 public 表：global-setup 的 prisma migrate deploy 是否执行成功？");
  }
  const tableList = rows
    .map((row) => `"${row.table_name.replace(/"/g, '""')}"`)
    .join(", ");
  await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

/**
 * 在 beforeAll 中调用：校验测试库、获取跨 worker 文件锁、清空表、切换 DATABASE_URL。
 * 返回的 cleanup 必须在 afterAll 中调用（关闭 Prisma、恢复环境变量、释放锁）。
 */
export async function setupTestDatabase(): Promise<() => Promise<void>> {
  const testUrl = testDatabaseUrl;
  if (!testUrl) throw new Error("TEST_DATABASE_URL 未设置，不能在启用真实库用例时调用 setupTestDatabase。");

  const identity = assertSafeTestDatabaseUrl(testUrl, process.env.DATABASE_URL);
  const lockKey = `${LOCK_NAMESPACE}${identity.database}`;
  const lock = new Client({ connectionString: testUrl });
  try {
    await lock.connect();
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    await truncatePublicTables(lock);
  } catch (err) {
    await lock.end().catch(() => { /* 连接可能尚未建立 */ });
    throw err;
  }

  // 客户端在首次实例化时读取环境变量；LOG_LEVEL=ERROR 抑制 Prisma 的查询/信息日志，
  // 避免真实库用例把整个测试输出淹没（原五个测试文件各自维护同一段保存/恢复逻辑）。
  const previousUrl = process.env.DATABASE_URL;
  const previousLogLevel = process.env.LOG_LEVEL;
  process.env.DATABASE_URL = testUrl;
  process.env.LOG_LEVEL = "ERROR";
  let cleaned = false;

  return async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      const { closeDatabase } = await import("@server/core/database/client");
      await closeDatabase();
    } finally {
      restoreEnv("DATABASE_URL", previousUrl);
      restoreEnv("LOG_LEVEL", previousLogLevel);
      try {
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      } finally {
        await lock.end();
      }
    }
  };
}
