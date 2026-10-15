/**
 * Prisma 7 CLI 配置（specs/postgres-dialect-unification.md）。
 * v7 起 schema 内不再允许 datasource url，CLI（migrate diff / migrate deploy / db pull 等）
 * 的数据库连接统一取自此处的 datasource.url。
 *  - 服务器模式（DATABASE_URL 为 postgres://）：CLI 直连真 PG（entrypoint 传环境变量）。
 *  - 本地模式：不设置 datasource，迁移 SQL 的应用由自研 runner（server/core/database/migrate.ts）
 *    在应用启动时完成；开发期新迁移的「授权/生成」走 scripts/db/author-migration.mts
 *    （createPgliteMigration API，规避 prisma-pglite CLI 的 Windows argv bug）。
 */
import path from "node:path";
import { defineConfig } from "prisma/config";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isServerDatabaseUrl =
  databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");

export default defineConfig({
  schema: path.join(import.meta.dirname, "prisma", "schema.prisma"),
  // 仅服务器模式向 CLI 提供连接；本地模式保持缺省，防止 CLI 误连 SQLite 时代的旧语义
  ...(isServerDatabaseUrl
    ? { datasource: { url: databaseUrl } }
    : {}),
});
