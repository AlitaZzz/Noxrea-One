-- DropIndex
DROP INDEX "asset_items_user_id_idx";

-- AlterTable
ALTER TABLE "asset_items" ADD COLUMN "source_url" TEXT;
ALTER TABLE "asset_items" ADD COLUMN "source_url_hash" TEXT;

-- CreateTable
CREATE TABLE "asset_space_stats" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "space_key" TEXT NOT NULL DEFAULT 'personal',
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "uncategorized_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "asset_space_stats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_asset_folders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "space_key" TEXT NOT NULL DEFAULT 'personal',
    "parent_id" INTEGER,
    "direct_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asset_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "asset_folders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_asset_folders" ("created_at", "id", "name", "parent_id", "space_key", "user_id") SELECT "created_at", "id", "name", "parent_id", "space_key", "user_id" FROM "asset_folders";
DROP TABLE "asset_folders";
ALTER TABLE "new_asset_folders" RENAME TO "asset_folders";
CREATE INDEX "asset_folders_user_id_space_key_parent_id_idx" ON "asset_folders"("user_id", "space_key", "parent_id");
CREATE INDEX "asset_folders_parent_id_idx" ON "asset_folders"("parent_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "asset_space_stats_user_id_space_key_key" ON "asset_space_stats"("user_id", "space_key");

-- CreateIndex
CREATE INDEX "asset_items_user_id_space_key_folder_id_created_at_idx" ON "asset_items"("user_id", "space_key", "folder_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "asset_items_user_id_space_key_source_url_hash_key" ON "asset_items"("user_id", "space_key", "source_url_hash");
