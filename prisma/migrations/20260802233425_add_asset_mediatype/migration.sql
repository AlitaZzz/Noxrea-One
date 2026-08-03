-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_asset_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "folder_id" INTEGER,
    "space_key" TEXT NOT NULL DEFAULT 'personal',
    "name" TEXT NOT NULL DEFAULT 'Untitled',
    "type" TEXT NOT NULL DEFAULT 'other',
    "media_type" TEXT NOT NULL DEFAULT '',
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "extra_data" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asset_items_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "asset_folders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_asset_items" ("created_at", "description", "extra_data", "folder_id", "height", "id", "name", "space_key", "tags", "type", "updated_at", "user_id", "width") SELECT "created_at", "description", "extra_data", "folder_id", "height", "id", "name", "space_key", "tags", "type", "updated_at", "user_id", "width" FROM "asset_items";
DROP TABLE "asset_items";
ALTER TABLE "new_asset_items" RENAME TO "asset_items";
CREATE INDEX "asset_items_user_id_idx" ON "asset_items"("user_id");
CREATE INDEX "asset_items_folder_id_idx" ON "asset_items"("folder_id");
CREATE INDEX "asset_items_media_type_idx" ON "asset_items"("media_type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- 清空历史资产数据（mediaType 字段上线前的数据已无媒体类型，统一清空由客户端重新导入）
DELETE FROM "asset_items";
