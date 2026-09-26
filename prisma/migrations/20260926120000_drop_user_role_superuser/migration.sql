-- 用户体系实际未使用角色/超管位（单一用户群），按迁移删除方案移除列
ALTER TABLE "users" DROP COLUMN "role";
ALTER TABLE "users" DROP COLUMN "is_superuser";
