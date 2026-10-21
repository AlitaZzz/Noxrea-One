/**
 * 开发期迁移授权入口（specs/pglite-removal.md）。
 * 改 prisma/schema.prisma 后运行：npm run db:migrate:new -- <migration-name>
 *
 * 使用 `prisma migrate diff --from-migrations --to-schema`：
 * - 只连接 SHADOW_DATABASE_URL（可丢弃的 shadow 库）：把 prisma/migrations 回放到
 *   shadow 库后与 schema 做差分，不连接 DATABASE_URL、不应用迁移、不重置开发库；
 * - 差分结果为空时 Prisma 输出仅含注释的空脚本，按“无差异”处理；
 * - 生成后执行一次 prisma generate（Prisma 7 不再随迁移命令自动生成客户端）。
 *
 * 迁移的 drift 检测不在授权阶段：部署路径 `migrate deploy` 只应用未执行迁移，
 * 开发库结构是否漂移由 `prisma migrate status` / 部署流程负责，本脚本不触碰开发库。
 */
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assertDistinctDatabaseTargets,
  parsePostgresDatabaseTarget,
} from "../../server/core/database/connection-string";
import { repoRoot } from "../lib/paths.mts";
import { capturePrisma, failWithPrismaError, runPrisma } from "../lib/prisma-cli.mts";

const prismaDir = path.join(repoRoot, "prisma");
const migrationsDir = path.join(prismaDir, "migrations");
const schemaFile = path.join(prismaDir, "schema.prisma");

/** Prisma 的空差分脚本可能带说明注释（如 `-- This is an empty migration.`）；按去注释后的 SQL 判定。 */
function isEffectivelyEmpty(sql: string): boolean {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim() === "";
}

/** Prisma 迁移目录命名：UTC 时间戳 + 名称（与 CLI 生成格式一致）。 */
function migrationDirectoryName(name: string): string {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${timestamp}_${name}`;
}

function main(): void {
  const migrationName = process.argv[2];
  if (!migrationName) {
    console.error("用法：npm run db:migrate:new -- <migration-name>（如 add-user-bio）");
    process.exit(1);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(migrationName)) {
    console.error(
      `迁移名不合法：${migrationName}\n` +
        "只能包含字母、数字、连字符和下划线，且必须以字母或数字开头（如 add-user-bio）。",
    );
    process.exit(1);
  }

  const shadowUrl = process.env.SHADOW_DATABASE_URL;
  if (!shadowUrl) {
    throw new Error(
      "缺少 SHADOW_DATABASE_URL：迁移授权只在 shadow 库上生成 SQL，不读取 DATABASE_URL。请在 .env 配置一个可丢弃的 PostgreSQL 库。",
    );
  }
  parsePostgresDatabaseTarget(shadowUrl, "SHADOW_DATABASE_URL");
  const appUrl = process.env.DATABASE_URL;
  if (appUrl) {
    assertDistinctDatabaseTargets(
      { url: shadowUrl, label: "SHADOW_DATABASE_URL" },
      { url: appUrl, label: "DATABASE_URL" },
      "shadow 库会被迁移授权回放/重置，可能删除业务数据。",
    );
  }

  // 差分只回放迁移到 shadow 库并使用 schema 作为目标，DATABASE_URL 不参与。
  const sql = capturePrisma([
    "migrate",
    "diff",
    "--from-migrations",
    migrationsDir,
    "--to-schema",
    schemaFile,
    "--script",
  ]);
  if (isEffectivelyEmpty(sql)) {
    console.log("schema 与既有迁移无差异，未生成迁移。");
    return;
  }

  const directoryName = migrationDirectoryName(migrationName);
  const directory = path.join(migrationsDir, directoryName);
  if (existsSync(directory)) {
    throw new Error(`迁移目录已存在：${directoryName}`);
  }

  // 先写入同卷临时目录再整体改名：写文件失败时不会留下半个迁移目录。
  // staging 放在 prisma/ 下（migrations 之外），不会被 Prisma 扫描为迁移。
  const stagingDirectory = mkdtempSync(path.join(prismaDir, ".tmp-migration-"));
  try {
    writeFileSync(path.join(stagingDirectory, "migration.sql"), sql.endsWith("\n") ? sql : `${sql}\n`);
    renameSync(stagingDirectory, directory);
  } catch (err) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw err;
  }

  console.log(`迁移已生成：${directoryName}`);
  runPrisma(["generate"]);
  console.log("请审阅 migration.sql；提交后执行 `npm run db:migrate:deploy` 应用。");
}

try {
  main();
} catch (err) {
  failWithPrismaError("迁移授权失败", err);
}
