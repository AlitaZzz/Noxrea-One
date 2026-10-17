-- DropIndex
DROP INDEX "asset_items_user_id_scope_source_url_key";

-- AlterTable（列改名保留存量数据；旧 URL 值由 key 化数据迁移脚本随后重写）
ALTER TABLE "asset_items" RENAME COLUMN "source_url" TO "file_key";

-- AlterTable
ALTER TABLE "canvas_projects" RENAME COLUMN "cover_url" TO "cover_key";

-- CreateIndex
CREATE UNIQUE INDEX "asset_items_user_id_scope_file_key_key" ON "asset_items"("user_id", "scope", "file_key");
