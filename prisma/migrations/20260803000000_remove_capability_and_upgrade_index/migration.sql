-- DropIndex
DROP INDEX "generation_tasks_user_id_idx";

-- AlterTable
ALTER TABLE "generation_tasks" DROP COLUMN "capability";

-- CreateIndex
CREATE INDEX "generation_tasks_user_id_created_at_idx" ON "generation_tasks"("user_id", "created_at");
