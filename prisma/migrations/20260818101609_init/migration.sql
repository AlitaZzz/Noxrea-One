-- CreateTable
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

-- CreateTable
CREATE TABLE "generation_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" INTEGER NOT NULL,
    "node_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "model" TEXT,
    "protocol" TEXT,
    "prompt" TEXT NOT NULL DEFAULT '',
    "config" TEXT NOT NULL DEFAULT '{}',
    "ref_images" TEXT,
    "ref_audios" TEXT,
    "ref_videos" TEXT,
    "result_urls" TEXT,
    "result_text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "error_code" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "upstream_task_id" TEXT,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "generation_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "canvas_projects" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Untitled',
    "canvas_data" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "canvas_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "model_providers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key" TEXT NOT NULL DEFAULT '',
    "protocol" TEXT NOT NULL DEFAULT 'openai',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "model_infos" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "provider_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_infos_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_providers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "asset_folders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "space_key" TEXT NOT NULL DEFAULT 'personal',
    "parent_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asset_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "asset_folders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
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
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asset_items_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "asset_folders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "file_objects" (
    "user_id" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mime_type" TEXT NOT NULL DEFAULT '',
    "ext" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'unknown',
    "ref_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("user_id", "hash")
);

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "project_id" INTEGER,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "active_skill" TEXT,
    "skill_status" TEXT NOT NULL DEFAULT 'idle',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_messages" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "tool_call_id" TEXT,
    "tool_name" TEXT,
    "ref_images" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "generation_tasks_user_id_created_at_idx" ON "generation_tasks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "generation_tasks_status_idx" ON "generation_tasks"("status");

-- CreateIndex
CREATE INDEX "canvas_projects_user_id_idx" ON "canvas_projects"("user_id");

-- CreateIndex
CREATE INDEX "model_providers_user_id_idx" ON "model_providers"("user_id");

-- CreateIndex
CREATE INDEX "asset_folders_user_id_idx" ON "asset_folders"("user_id");

-- CreateIndex
CREATE INDEX "asset_folders_parent_id_idx" ON "asset_folders"("parent_id");

-- CreateIndex
CREATE INDEX "asset_items_user_id_idx" ON "asset_items"("user_id");

-- CreateIndex
CREATE INDEX "asset_items_folder_id_idx" ON "asset_items"("folder_id");

-- CreateIndex
CREATE INDEX "asset_items_media_type_idx" ON "asset_items"("media_type");

-- CreateIndex
CREATE INDEX "agent_sessions_user_id_project_id_idx" ON "agent_sessions"("user_id", "project_id");

-- CreateIndex
CREATE INDEX "agent_messages_session_id_created_at_idx" ON "agent_messages"("session_id", "created_at");
