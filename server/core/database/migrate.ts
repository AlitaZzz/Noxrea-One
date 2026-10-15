/**
 * 本地模式迁移 runner（specs/postgres-dialect-unification.md）。
 * 语义对齐 `prisma migrate deploy`：按目录名序应用 prisma/migrations 下未应用的迁移，
 * 每个迁移一个事务（PG DDL 可回滚），记账写入 _prisma_migrations（含 sha256 checksum）。
 * 已应用迁移的 checksum 不符即拒绝启动（迁移文件被改动的防护）；失败迁移整体回滚、不记账。
 * 仅用于 PGlite 本地模式；服务器模式走部署侧原生 `prisma migrate deploy`（同一迁移目录，单一演进源）。
 */
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { logEvent } from "@server/core/logger/utils";

/** 迁移目录锚定在仓库内，不依赖进程 cwd（server/core/database → 仓库根/prisma/migrations）。 */
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../prisma/migrations");

export async function runPendingMigrations(pglite: PGlite): Promise<string[]> {
  // 记账表结构与 Prisma migrate deploy 一致，保证两套应用器对同一库可互换接管（阶段 2 验收项）
  await pglite.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  )`);

  const applied = new Map<string, string>();
  const recorded = await pglite.query<{ migration_name: string; checksum: string }>(
    `SELECT migration_name, checksum FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`,
  );
  for (const row of recorded.rows) applied.set(row.migration_name, row.checksum);

  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const appliedNow: string[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");

    const known = applied.get(name);
    if (known !== undefined) {
      if (known !== checksum) {
        throw new Error(
          `迁移 ${name} 已应用但 checksum 不一致（迁移文件被修改？）。` +
            `本地库请勿手改已应用的迁移；确需变更请新增迁移。`,
        );
      }
      continue;
    }

    try {
      await pglite.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query(
          `INSERT INTO "_prisma_migrations"
             (id, checksum, finished_at, migration_name, applied_steps_count)
           VALUES ($1, $2, now(), $3, 1)`,
          [randomUUID(), checksum, name],
        );
      });
    } catch (err) {
      // 失败迁移已随事务整体回滚、未记账；报错上抛让启动失败（拒绝带未迁移库服务）
      throw new Error(`迁移 ${name} 应用失败，已整体回滚：${err instanceof Error ? err.message : String(err)}`);
    }
    appliedNow.push(name);
  }

  if (appliedNow.length > 0) {
    logEvent("database", { stage: "local_migrations_applied", migrations: appliedNow });
  }
  return appliedNow;
}
