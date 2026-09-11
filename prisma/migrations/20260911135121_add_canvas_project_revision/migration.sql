-- 画布项目增加乐观并发版本号，防止网络重试或迟到请求回退引用账本。
ALTER TABLE "canvas_projects" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
