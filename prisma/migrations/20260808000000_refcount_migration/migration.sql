-- 1. 给 file_objects 加 ref_count 列（默认 0）
ALTER TABLE "file_objects" ADD COLUMN "ref_count" INTEGER NOT NULL DEFAULT 0;

-- 2. 从 file_references 统计每个文件的引用数，回填到 ref_count
UPDATE "file_objects"
SET "ref_count" = (
  SELECT COUNT(*)
  FROM "file_references"
  WHERE "file_references"."file_hash" = "file_objects"."hash"
    AND "file_references"."user_id" = "file_objects"."user_id"
);

-- 3. 删除 file_references 表及其索引
DROP INDEX IF EXISTS "uq_file_ref";
DROP INDEX IF EXISTS "idx_fr_hash_user";
DROP INDEX IF EXISTS "idx_fr_type_id";
DROP TABLE IF EXISTS "file_references";
