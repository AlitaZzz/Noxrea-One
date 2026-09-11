-- CreateTable
CREATE TABLE "file_refs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "file_refs_user_id_hash_idx" ON "file_refs"("user_id", "hash");

-- CreateIndex
CREATE INDEX "file_refs_user_id_source_type_source_id_idx" ON "file_refs"("user_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_refs_source_type_source_id_hash_key" ON "file_refs"("source_type", "source_id", "hash");

-- 从既有资产条目回填引用账本；仅内部 CAS URL 可解析出 hash，外部来源不参与计数。
WITH parsed_asset_urls AS (
    SELECT
        ai.user_id,
        CAST(ai.id AS TEXT) AS source_id,
        substr(
            substr(ai.source_url, instr(ai.source_url, '/api/files/') + 11),
            instr(substr(ai.source_url, instr(ai.source_url, '/api/files/') + 11), '/') + 1,
            64
        ) AS hash
    FROM asset_items AS ai
    WHERE ai.source_url LIKE '%/api/files/%'
),
valid_asset_refs AS (
    SELECT user_id, source_id, lower(hash) AS hash
    FROM parsed_asset_urls
    WHERE length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'
)
INSERT INTO "file_refs" ("user_id", "source_type", "source_id", "hash", "count", "created_at", "updated_at")
SELECT user_id, 'asset_item', source_id, hash, COUNT(*), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM valid_asset_refs
GROUP BY user_id, source_id, hash;

-- 从既有画布节点回填引用账本；每个节点只计一次，复制出的不同节点分别累加。
WITH parsed_canvas_nodes AS (
    SELECT
        cp.user_id,
        cp.id AS source_id,
        json_extract(je.value, '$.data.src') AS source_url
    FROM canvas_projects AS cp
    JOIN json_each(cp.canvas_data, '$.nodes') AS je
    WHERE json_type(cp.canvas_data, '$.nodes') = 'array'
),
parsed_canvas_urls AS (
    SELECT
        user_id,
        source_id,
        substr(
            substr(source_url, instr(source_url, '/api/files/') + 11),
            instr(substr(source_url, instr(source_url, '/api/files/') + 11), '/') + 1,
            64
        ) AS hash
    FROM parsed_canvas_nodes
    WHERE source_url LIKE '%/api/files/%'
),
valid_canvas_refs AS (
    SELECT user_id, source_id, lower(hash) AS hash
    FROM parsed_canvas_urls
    WHERE length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'
)
INSERT INTO "file_refs" ("user_id", "source_type", "source_id", "hash", "count", "created_at", "updated_at")
SELECT user_id, 'canvas', source_id, hash, COUNT(*), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM valid_canvas_refs
GROUP BY user_id, source_id, hash;

-- 以账本为准重建聚合计数，修正历史复制节点未加一与过期负数计数。
UPDATE "file_objects"
SET "ref_count" = COALESCE((
    SELECT SUM(fr."count")
    FROM "file_refs" AS fr
    WHERE fr."user_id" = "file_objects"."user_id"
      AND fr."hash" = "file_objects"."hash"
), 0),
"updated_at" = CURRENT_TIMESTAMP;
