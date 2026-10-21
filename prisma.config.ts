/**
 * Prisma 7 CLI 配置（specs/pglite-removal.md）。
 * v7 起 schema 内不再允许 datasource url，CLI（migrate dev / migrate deploy / migrate diff 等）
 * 的数据库连接统一取自此处的 datasource.url。
 *
 * DATABASE_URL 由进程入口注入（tsx --env-file=.env / entrypoint source / CI job 环境）；
 * v7 CLI 不再自动加载 .env，因此这里不引入 dotenv。
 *
 * datasource 在 URL 已设置时提供并先做校验：
 * `prisma generate`（postinstall / 镜像构建）不依赖数据库连接，构建期没有连接串时
 * 仍必须能生成客户端；一旦设置，非法值就属于配置错误，应在 CLI 启动前暴露。
 */
import path from "node:path";
import { defineConfig } from "prisma/config";

import {
  assertDistinctDatabaseTargets,
  parsePostgresDatabaseTarget,
} from "./server/core/database/connection-string";

const databaseUrl = process.env.DATABASE_URL ?? "";
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL ?? "";

if (databaseUrl) parsePostgresDatabaseTarget(databaseUrl, "DATABASE_URL");
if (shadowDatabaseUrl) parsePostgresDatabaseTarget(shadowDatabaseUrl, "SHADOW_DATABASE_URL");

assertDistinctDatabaseTargets(
  { url: shadowDatabaseUrl, label: "SHADOW_DATABASE_URL" },
  { url: databaseUrl, label: "DATABASE_URL" },
  "shadow 库会被迁移授权回放/重置，可能删除业务数据。",
);

// url 与 shadowDatabaseUrl 相互独立：迁移授权只需要 shadow 库（不读取 DATABASE_URL），
// 因此 DATABASE_URL 缺失时仍必须把 shadow 库交给 CLI。
const datasource = {
  ...(databaseUrl ? { url: databaseUrl } : {}),
  ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
};

export default defineConfig({
  schema: path.join(import.meta.dirname, "prisma", "schema.prisma"),
  ...(Object.keys(datasource).length > 0 ? { datasource } : {}),
});
