-- 提示词从 extra_data JSON 中独立为一列
-- AlterTable
ALTER TABLE "asset_items" ADD COLUMN "prompt" TEXT NOT NULL DEFAULT '';

-- Backfill：将历史数据 extra_data.prompt 迁入新列（SQLite json_extract）
UPDATE "asset_items"
SET "prompt" = COALESCE(json_extract("extra_data", '$.prompt'), '')
WHERE "extra_data" IS NOT NULL AND json_extract("extra_data", '$.prompt') IS NOT NULL;

-- DropColumn（SQLite >= 3.35 支持；extra_data 无索引 / 唯一约束 / 外键引用）
ALTER TABLE "asset_items" DROP COLUMN "extra_data";
