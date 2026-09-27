-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_canvas_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Untitled',
    "canvas_data" TEXT NOT NULL DEFAULT '{}',
    "cover_url" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "node_count" INTEGER NOT NULL DEFAULT 0,
    "thumbnail_src" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "canvas_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_canvas_projects" ("canvas_data", "cover_url", "created_at", "id", "name", "revision", "updated_at", "user_id") SELECT "canvas_data", "cover_url", "created_at", "id", "name", "revision", "updated_at", "user_id" FROM "canvas_projects";
DROP TABLE "canvas_projects";
ALTER TABLE "new_canvas_projects" RENAME TO "canvas_projects";
CREATE INDEX "canvas_projects_user_id_idx" ON "canvas_projects"("user_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- 一次性回填存量画布的摘要冗余列（坏 JSON 行保持 0/null，与列表摘要降级语义一致）
UPDATE "canvas_projects"
SET "node_count" = CASE WHEN json_valid("canvas_data")
    THEN COALESCE(json_array_length("canvas_data", '$.nodes'), 0) ELSE 0 END,
    "thumbnail_src" = CASE WHEN json_valid("canvas_data") THEN (
      SELECT json_extract(je.value, '$.data.src')
      FROM json_each("canvas_projects"."canvas_data", '$.nodes') je
      WHERE json_extract(je.value, '$.type') = 'image-node'
        AND json_type(je.value, '$.data.src') = 'text'
      LIMIT 1
    ) ELSE NULL END;
