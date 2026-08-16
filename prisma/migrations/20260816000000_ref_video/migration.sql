-- 为 generation_tasks 增加参考音频/视频 URL 数组列（JSON TEXT）
ALTER TABLE "generation_tasks" ADD COLUMN "ref_audios" TEXT;
ALTER TABLE "generation_tasks" ADD COLUMN "ref_videos" TEXT;