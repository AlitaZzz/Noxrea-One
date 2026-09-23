-- 一次性数据迁移：旧版 agent 回复文本曾存于 message_user 工具调用的 args.text 中，
-- assistant 消息 content 为空；现行写入侧（agent.ts finishTurn）已将其提升到 content。
-- 本迁移把历史行提升到统一格式，前端读取不再需要兼容分支。
-- 只触碰 content 为空且 toolCalls 内含非空 message_user args.text 的 assistant 行，幂等可重放。
UPDATE agent_messages AS m
SET content = (
  SELECT json_extract(j.value, '$.args.text')
  FROM json_each(m.tool_calls) AS j
  WHERE json_extract(j.value, '$.name') = 'message_user'
    AND json_type(j.value, '$.args.text') = 'text'
    AND json_extract(j.value, '$.args.text') != ''
  LIMIT 1
)
WHERE m.role = 'assistant'
  AND m.content = ''
  AND m.tool_calls IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM json_each(m.tool_calls) AS j
    WHERE json_extract(j.value, '$.name') = 'message_user'
      AND json_type(j.value, '$.args.text') = 'text'
      AND json_extract(j.value, '$.args.text') != ''
  );
