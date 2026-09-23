-- 画布 Agent 重构：移除技能系统字段，新增 assistant 工具调用持久化列
ALTER TABLE "agent_sessions" DROP COLUMN "active_skill";
ALTER TABLE "agent_sessions" DROP COLUMN "skill_status";
ALTER TABLE "agent_messages" ADD COLUMN "tool_calls" TEXT;
