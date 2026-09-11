-- 将应用层来源 URL 查重提升为数据库约束；NULL 仍允许多条。
DROP INDEX "asset_items_user_id_scope_source_url_idx";
CREATE UNIQUE INDEX "asset_items_user_id_scope_source_url_key"
ON "asset_items"("user_id", "scope", "source_url");
