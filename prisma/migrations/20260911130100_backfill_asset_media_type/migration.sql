-- 修复历史图片保存入口漏传 media_type 导致的空值；按来源文件扩展名回填。
UPDATE "asset_items"
SET "media_type" = CASE
    WHEN lower("source_url") LIKE '%.png'
      OR lower("source_url") LIKE '%.jpg'
      OR lower("source_url") LIKE '%.jpeg'
      OR lower("source_url") LIKE '%.gif'
      OR lower("source_url") LIKE '%.webp'
      OR lower("source_url") LIKE '%.bmp'
      OR lower("source_url") LIKE '%.svg' THEN 'image'
    WHEN lower("source_url") LIKE '%.mp4'
      OR lower("source_url") LIKE '%.webm'
      OR lower("source_url") LIKE '%.mov'
      OR lower("source_url") LIKE '%.avi'
      OR lower("source_url") LIKE '%.mkv'
      OR lower("source_url") LIKE '%.m4v' THEN 'video'
    WHEN lower("source_url") LIKE '%.mp3'
      OR lower("source_url") LIKE '%.wav'
      OR lower("source_url") LIKE '%.ogg'
      OR lower("source_url") LIKE '%.m4a'
      OR lower("source_url") LIKE '%.aac'
      OR lower("source_url") LIKE '%.flac' THEN 'audio'
    ELSE "media_type"
END
WHERE "media_type" = ''
  AND "source_url" IS NOT NULL;

-- 来源 URL 和来源类型已提升为独立列，不再重复保存在扩展 JSON 中。
UPDATE "asset_items"
SET "extra_data" = json_remove("extra_data", '$.sourceUrl', '$.source')
WHERE json_extract("extra_data", '$.sourceUrl') IS NOT NULL
   OR json_extract("extra_data", '$.source') IS NOT NULL;
