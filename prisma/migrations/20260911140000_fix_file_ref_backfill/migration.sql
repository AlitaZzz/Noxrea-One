-- 重建引用账本：修正初始回填 SQL 未跳过 hash 前两位目录的问题。
DELETE FROM "file_refs";

WITH parsed_asset_paths AS (
    SELECT
        ai.user_id,
        CAST(ai.id AS TEXT) AS source_id,
        substr(ai.source_url, instr(ai.source_url, '/api/files/') + 11) AS path
    FROM asset_items AS ai
    WHERE ai.source_url LIKE '%/api/files/%'
),
parsed_asset_names AS (
    SELECT
        user_id,
        source_id,
        substr(path, instr(path, '/') + 1) AS tail
    FROM parsed_asset_paths
),
parsed_asset_urls AS (
    SELECT
        user_id,
        source_id,
        substr(tail, instr(tail, '/') + 1, 64) AS hash
    FROM parsed_asset_names
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

WITH parsed_canvas_nodes AS (
    SELECT
        cp.user_id,
        cp.id AS source_id,
        json_extract(je.value, '$.data.src') AS source_url
    FROM canvas_projects AS cp
    JOIN json_each(cp.canvas_data, '$.nodes') AS je
    WHERE json_type(cp.canvas_data, '$.nodes') = 'array'
),
parsed_canvas_paths AS (
    SELECT
        user_id,
        source_id,
        substr(source_url, instr(source_url, '/api/files/') + 11) AS path
    FROM parsed_canvas_nodes
    WHERE source_url LIKE '%/api/files/%'
),
parsed_canvas_names AS (
    SELECT
        user_id,
        source_id,
        substr(path, instr(path, '/') + 1) AS tail
    FROM parsed_canvas_paths
),
parsed_canvas_urls AS (
    SELECT
        user_id,
        source_id,
        substr(tail, instr(tail, '/') + 1, 64) AS hash
    FROM parsed_canvas_names
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

UPDATE "file_objects"
SET "ref_count" = COALESCE((
    SELECT SUM(fr."count")
    FROM "file_refs" AS fr
    WHERE fr."user_id" = "file_objects"."user_id"
      AND fr."hash" = "file_objects"."hash"
), 0),
"updated_at" = CURRENT_TIMESTAMP;
