-- 头像引用账本回填（specs/storage-s3-backend.md 头像账本轮）：FileRefSourceType 新增
-- avatar 来源后，为存量用户补齐账本行并同步聚合计数。守卫集合两条写操作完全一致：
--   1) avatar 为 key 严格形态（STORAGE_KEY_PATTERN 同款正则：任意数字 userId 段 +
--      可选扩展名，与运行时判别完全同口径，不按实际用户 id 收窄）；
--   2) file_objects 对象行在位——对象已回收/不存在的用户无可保护对象，跳过留待运行时
--      下次设置头像时按整替语义自愈，避免幽灵账本行破坏 ref_count 聚合不变量；
--   3) 该用户尚无任何 avatar 账本行（每用户至多一行契约；存在旧行的库跳过并自愈）。
-- 单语句双 CTE：eligible 只计算一次，UPDATE 与 INSERT 消费同一集合；同一语句原子生效。
-- 幂等：已回填环境（含手工补过账本的库）零写入。
WITH eligible AS (
  SELECT u.id AS user_id, m.hash AS hash
  FROM users u,
  LATERAL (
    SELECT substring(u.avatar from '^(?:\d+)/[0-9a-f]{2}/([0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$') AS hash
  ) m
  WHERE u.avatar IS NOT NULL
    AND m.hash IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM file_objects fo
      WHERE fo.user_id = u.id AND fo.hash = m.hash
    )
    AND NOT EXISTS (
      SELECT 1 FROM file_refs fr
      WHERE fr.user_id = u.id AND fr.source_type = 'avatar'
    )
), reclaimed AS (
  UPDATE file_objects fo
  SET ref_count = fo.ref_count + 1
  FROM eligible
  WHERE fo.user_id = eligible.user_id AND fo.hash = eligible.hash
)
INSERT INTO file_refs (user_id, source_type, source_id, hash, count, created_at, updated_at)
SELECT user_id, 'avatar', user_id::text, hash, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM eligible;
