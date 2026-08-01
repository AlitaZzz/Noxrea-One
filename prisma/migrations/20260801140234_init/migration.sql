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
    "type" TEXT NOT NULL,
    "capability" TEXT,
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
    "result_urls" TEXT,
    "result_text" TEXT,
    "error" TEXT,
    "node_id" TEXT NOT NULL,
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
CREATE TABLE "model_channels" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key" TEXT NOT NULL DEFAULT '',
    "protocol" TEXT NOT NULL DEFAULT 'openai',
    "config" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "model_infos" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "inferred_capabilities" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_infos_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "model_channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("user_id", "hash")
);

-- CreateTable
CREATE TABLE "file_references" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "file_hash" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "generation_tasks_user_id_idx" ON "generation_tasks"("user_id");

-- CreateIndex
CREATE INDEX "generation_tasks_status_idx" ON "generation_tasks"("status");

-- CreateIndex
CREATE INDEX "canvas_projects_user_id_idx" ON "canvas_projects"("user_id");

-- CreateIndex
CREATE INDEX "model_channels_user_id_idx" ON "model_channels"("user_id");

-- CreateIndex
CREATE INDEX "asset_folders_user_id_idx" ON "asset_folders"("user_id");

-- CreateIndex
CREATE INDEX "asset_folders_parent_id_idx" ON "asset_folders"("parent_id");

-- CreateIndex
CREATE INDEX "asset_items_user_id_idx" ON "asset_items"("user_id");

-- CreateIndex
CREATE INDEX "asset_items_folder_id_idx" ON "asset_items"("folder_id");

-- CreateIndex
CREATE INDEX "idx_fr_hash_user" ON "file_references"("file_hash", "user_id");

-- CreateIndex
CREATE INDEX "idx_fr_type_id" ON "file_references"("ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_references_file_hash_user_id_ref_type_ref_id_key" ON "file_references"("file_hash", "user_id", "ref_type", "ref_id");
