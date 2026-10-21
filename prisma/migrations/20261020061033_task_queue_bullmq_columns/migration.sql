-- AlterTable
ALTER TABLE "generation_tasks" ADD COLUMN     "async_poll_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_poll_at" TIMESTAMP(3),
ADD COLUMN     "submission_state" TEXT NOT NULL DEFAULT 'not_sent';
