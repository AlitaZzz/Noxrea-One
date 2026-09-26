-- Agent 会话与画布项目建立真实外键关系。
-- 历史上 project_id 是自由字符串，可能已留下项目不存在/不归属同一用户的孤儿会话；
-- 先显式清理其消息，再重建 agent_sessions 添加外键，避免迁移在脏数据上失败。
DELETE FROM "agent_messages"
WHERE "session_id" IN (
    SELECT "id"
    FROM "agent_sessions"
    WHERE "project_id" IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM "canvas_projects"
          WHERE "canvas_projects"."id" = "agent_sessions"."project_id"
            AND "canvas_projects"."user_id" = "agent_sessions"."user_id"
      )
);
DELETE FROM "agent_sessions"
WHERE "project_id" IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "canvas_projects"
      WHERE "canvas_projects"."id" = "agent_sessions"."project_id"
        AND "canvas_projects"."user_id" = "agent_sessions"."user_id"
  );

-- SQLite 不支持 ALTER TABLE ADD CONSTRAINT，需重建表以添加 project 外键。
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_agent_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "project_id" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "canvas_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_agent_sessions" ("id", "user_id", "project_id", "title", "created_at", "updated_at")
SELECT "id", "user_id", "project_id", "title", "created_at", "updated_at"
FROM "agent_sessions";
DROP TABLE "agent_sessions";
ALTER TABLE "new_agent_sessions" RENAME TO "agent_sessions";
CREATE INDEX "agent_sessions_user_id_project_id_idx" ON "agent_sessions"("user_id", "project_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
