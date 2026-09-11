-- DropIndex
DROP INDEX "asset_space_stats_user_id_space_key_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "asset_space_stats";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_asset_folders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "kind" TEXT NOT NULL DEFAULT 'normal',
    "parent_id" INTEGER,
    "direct_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asset_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "asset_folders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_asset_folders" ("created_at", "direct_count", "id", "kind", "name", "parent_id", "scope", "user_id")
SELECT "created_at", "direct_count", "id", 'normal', "name", "parent_id", "space_key", "user_id" FROM "asset_folders";
DROP TABLE "asset_folders";
ALTER TABLE "new_asset_folders" RENAME TO "asset_folders";

-- 为每个用户补齐系统「未分类」目录；这是资产库中的固定根目录。
INSERT INTO "asset_folders" ("user_id", "name", "scope", "kind", "parent_id", "direct_count", "created_at")
SELECT u."id", 'Uncategorized', 'personal', 'uncategorized', NULL, 0, CURRENT_TIMESTAMP
FROM "users" u
WHERE NOT EXISTS (
    SELECT 1 FROM "asset_folders" f
    WHERE f."user_id" = u."id" AND f."scope" = 'personal' AND f."kind" = 'uncategorized'
);
CREATE UNIQUE INDEX "asset_folders_user_scope_uncategorized_key"
ON "asset_folders"("user_id", "scope") WHERE "kind" = 'uncategorized';

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
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "extra_data" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asset_items_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "asset_folders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_asset_items" (
    "created_at", "description", "extra_data", "folder_id", "height", "id", "media_type",
    "name", "scope", "source_type", "source_url", "tags", "type", "updated_at", "user_id", "width"
)
SELECT
    a."created_at", a."description", a."extra_data",
    COALESCE(
        a."folder_id",
        (SELECT f."id" FROM "asset_folders" f
         WHERE f."user_id" = a."user_id" AND f."scope" = 'personal' AND f."kind" = 'uncategorized'
         LIMIT 1)
    ),
    a."height", a."id", a."media_type", a."name", a."space_key",
    COALESCE(json_extract(a."extra_data", '$.source'), ''),
    a."source_url", a."tags", a."type", a."updated_at", a."user_id", a."width"
FROM "asset_items" a;
DROP TABLE "asset_items";
ALTER TABLE "new_asset_items" RENAME TO "asset_items";

-- 目录直属计数以迁移后的真实归属重建，file_objects.ref_count 不做任何改动。
UPDATE "asset_folders"
SET "direct_count" = (
    SELECT COUNT(*) FROM "asset_items" i WHERE i."folder_id" = "asset_folders"."id"
);

CREATE INDEX "asset_folders_user_id_scope_parent_id_idx" ON "asset_folders"("user_id", "scope", "parent_id");
CREATE INDEX "asset_folders_user_id_scope_kind_idx" ON "asset_folders"("user_id", "scope", "kind");
CREATE INDEX "asset_folders_parent_id_idx" ON "asset_folders"("parent_id");
CREATE INDEX "asset_items_user_id_scope_folder_id_created_at_idx" ON "asset_items"("user_id", "scope", "folder_id", "created_at");
CREATE INDEX "asset_items_user_id_scope_source_url_idx" ON "asset_items"("user_id", "scope", "source_url");
CREATE INDEX "asset_items_folder_id_idx" ON "asset_items"("folder_id");
CREATE INDEX "asset_items_media_type_idx" ON "asset_items"("media_type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
