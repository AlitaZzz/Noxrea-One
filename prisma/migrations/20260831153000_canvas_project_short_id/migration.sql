-- 画布项目主键：自增 Int → 14 字符时间有序短 ID（应用层生成）
-- Agent 会话的 project_id 同步改为 TEXT 以匹配新 ID 类型。
--
-- 不向后兼容：旧画布项目使用自增 ID，无法映射到短 ID，因此提前清空。
-- 放在 RedefineTables 之前，避免 rebuild 时搬运注定要丢弃的数据。
-- agent_messages 依赖 agent_sessions，需先删子表。

DELETE FROM agent_messages;
DELETE FROM agent_sessions;
DELETE FROM canvas_projects;

-- RedefineTables

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_agent_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "project_id" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "active_skill" TEXT,
    "skill_status" TEXT NOT NULL DEFAULT 'idle',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_agent_sessions" ("active_skill", "created_at", "id", "project_id", "skill_status", "title", "updated_at", "user_id") SELECT "active_skill", "created_at", "id", "project_id", "skill_status", "title", "updated_at", "user_id" FROM "agent_sessions";
DROP TABLE "agent_sessions";
ALTER TABLE "new_agent_sessions" RENAME TO "agent_sessions";
CREATE INDEX "agent_sessions_user_id_project_id_idx" ON "agent_sessions"("user_id", "project_id");
CREATE TABLE "new_canvas_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Untitled',
    "canvas_data" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "canvas_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_canvas_projects" ("canvas_data", "created_at", "id", "name", "updated_at", "user_id") SELECT "canvas_data", "created_at", "id", "name", "updated_at", "user_id" FROM "canvas_projects";
DROP TABLE "canvas_projects";
ALTER TABLE "new_canvas_projects" RENAME TO "canvas_projects";
CREATE INDEX "canvas_projects_user_id_idx" ON "canvas_projects"("user_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
