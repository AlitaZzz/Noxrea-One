-- 合并后的完整结构（等价于原 5 个 migration 的最终净状态）
-- 仅用于迁移历史合并，不执行数据变更。

-- 1. users
CREATE TABLE "users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "avatar" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "lang" TEXT NOT NULL DEFAULT 'zh',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_superuser" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- 2. generation_tasks
CREATE TABLE "generation_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "protocol" TEXT,
    "model" TEXT,
    "upstream_task_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "prompt" TEXT NOT NULL DEFAULT '',
    "config" TEXT NOT NULL DEFAULT '{}',
    "ref_images" TEXT,
    "ref_audio" TEXT,
    "result_urls" TEXT,
    "result_text" TEXT,
    "error" TEXT,
    "node_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "generation_tasks_user_id_created_at_idx" ON "generation_tasks"("user_id","created_at");
CREATE INDEX "generation_tasks_status_idx" ON "generation_tasks"("status");

-- 3. canvas_projects
CREATE TABLE "canvas_projects" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Untitled',
    "canvas_data" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "canvas_projects_user_id_idx" ON "canvas_projects"("user_id");

-- 4. model_channels
CREATE TABLE "model_channels" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key" TEXT NOT NULL DEFAULT '',
    "protocol" TEXT NOT NULL DEFAULT 'openai',
    "config" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "model_channels_user_id_idx" ON "model_channels"("user_id");

-- 5. model_infos
CREATE TABLE "model_infos" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. asset_folders
CREATE TABLE "asset_folders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "space_key" TEXT NOT NULL DEFAULT 'personal',
    "parent_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "asset_folders_user_id_idx" ON "asset_folders"("user_id");
CREATE INDEX "asset_folders_parent_id_idx" ON "asset_folders"("parent_id");

-- 7. asset_items
CREATE TABLE "asset_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "folder_id" INTEGER,
    "space_key" TEXT NOT NULL DEFAULT 'personal',
    "name" TEXT NOT NULL DEFAULT 'Untitled',
    "type" TEXT NOT NULL DEFAULT 'other',
    "media_type" TEXT NOT NULL DEFAULT '',
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "extra_data" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "asset_items_user_id_idx" ON "asset_items"("user_id");
CREATE INDEX "asset_items_folder_id_idx" ON "asset_items"("folder_id");
CREATE INDEX "asset_items_media_type_idx" ON "asset_items"("media_type");

-- 8. file_objects
CREATE TABLE "file_objects" (
    "user_id" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mime_type" TEXT NOT NULL DEFAULT '',
    "ext" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'unknown',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("user_id","hash")
);

-- 9. file_references
CREATE TABLE "file_references" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "file_hash" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "uq_file_ref" ON "file_references"("file_hash","user_id","ref_type","ref_id");
CREATE INDEX "idx_fr_hash_user" ON "file_references"("file_hash","user_id");
CREATE INDEX "idx_fr_type_id" ON "file_references"("ref_type","ref_id");

-- 10. chat_sessions
CREATE TABLE "chat_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "project_id" INTEGER,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "chat_sessions_user_id_project_id_idx" ON "chat_sessions"("user_id","project_id");

-- 11. chat_messages
CREATE TABLE "chat_messages" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "ref_images" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "chat_messages_session_id_created_at_idx" ON "chat_messages"("session_id","created_at");
