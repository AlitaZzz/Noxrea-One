-- 并发首次访问「未分类」目录时可建出重复目录（find-then-create 无约束保护）。
-- 部分唯一索引：每用户每 scope 至多一个 kind = 'uncategorized' 的目录；
-- 普通目录（kind ≠ 'uncategorized'）不受限。
-- Prisma schema 无法表达部分唯一索引，本迁移为手写 SQL：
-- createPgliteMigration 的 schema 差分感知不到该对象，禁止改在 schema 层描述或重建它。
CREATE UNIQUE INDEX "asset_folders_uncategorized_key" ON "asset_folders"("user_id", "scope") WHERE kind = 'uncategorized';
