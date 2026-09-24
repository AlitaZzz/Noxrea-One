-- AlterTable
ALTER TABLE "file_objects" ADD COLUMN "duration" REAL;
ALTER TABLE "file_objects" ADD COLUMN "height" INTEGER;
ALTER TABLE "file_objects" ADD COLUMN "width" INTEGER;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_asset_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "folder_id" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "source_url" TEXT,
    "source_type" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT 'Untitled',
    "type" TEXT NOT NULL DEFAULT 'other',
    "media_type" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "prompt" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asset_items_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "asset_folders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_asset_items" ("created_at", "description", "folder_id", "id", "media_type", "name", "prompt", "scope", "source_type", "source_url", "tags", "type", "updated_at", "user_id") SELECT "created_at", "description", "folder_id", "id", "media_type", "name", "prompt", "scope", "source_type", "source_url", "tags", "type", "updated_at", "user_id" FROM "asset_items";
DROP TABLE "asset_items";
ALTER TABLE "new_asset_items" RENAME TO "asset_items";
CREATE INDEX "asset_items_user_id_scope_folder_id_created_at_idx" ON "asset_items"("user_id", "scope", "folder_id", "created_at");
CREATE INDEX "asset_items_folder_id_idx" ON "asset_items"("folder_id");
CREATE INDEX "asset_items_media_type_idx" ON "asset_items"("media_type");
CREATE UNIQUE INDEX "asset_items_user_id_scope_source_url_key" ON "asset_items"("user_id", "scope", "source_url");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
