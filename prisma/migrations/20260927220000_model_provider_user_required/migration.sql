-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_model_providers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key" TEXT NOT NULL DEFAULT '',
    "protocol" TEXT NOT NULL DEFAULT 'openai',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_model_providers" ("api_key", "base_url", "created_at", "id", "name", "protocol", "updated_at", "user_id") SELECT "api_key", "base_url", "created_at", "id", "name", "protocol", "updated_at", "user_id" FROM "model_providers";
DROP TABLE "model_providers";
ALTER TABLE "new_model_providers" RENAME TO "model_providers";
CREATE INDEX "model_providers_user_id_idx" ON "model_providers"("user_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

