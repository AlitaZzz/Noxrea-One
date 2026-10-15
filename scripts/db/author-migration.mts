/**
 * 开发期迁移授权入口（specs/postgres-dialect-unification.md §4）。
 * 改 prisma/schema.prisma 后运行：npm run db:migrate:new -- <migration-name>
 * 走 prisma-pglite 导出 API（其 CLI bin 在 Windows 有 argv 解析 bug，统一经此封装）。
 * 全程不启动任何数据库服务：新迁移 SQL 由「既有迁移重放进一次性影子 PGlite + 与 schema 差分」得出。
 */
import { createPgliteMigration } from "prisma-pglite";

async function main(): Promise<void> {
  const migrationName = process.argv[2];
  if (!migrationName) {
    console.error("用法：npm run db:migrate:new -- <migration-name>（如 add-user-bio）");
    process.exit(1);
  }

  const result = await createPgliteMigration({ migrationName });
  if (!result) {
    console.log("schema 与既有迁移无差异，未生成迁移。");
    return;
  }
  console.log(`迁移已生成：${result.migrationDirPath}`);
  console.log("提交该迁移目录后，本地模式下次启动时由迁移 runner 自动应用。");
}

main().catch((err) => {
  console.error("迁移授权失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
