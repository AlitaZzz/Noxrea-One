import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * MinIO 契约测试专用配置（specs/storage-provider-portability.md 规则 6.1）。
 *
 * 与 vitest.config.ts 的差别只有两处：只跑 S3 真桶用例，并在主进程求值期注入
 * `TEST_S3_*`（worker 子进程继承）——与 docker-compose.test.yml 的 MinIO 取值一致。
 * 其余（.env 注入点、`@server` 别名）与主配置同口径，不复制第二套语义。
 *
 * 运行前先起容器：`docker compose -f docker-compose.test.yml up -d minio`
 * 然后：`npm run test:storage:minio`
 */

// 与 vitest.config.ts 同一条约定：测试进程树的 env 注入点是配置本身，
// config 模块不做 .env 兜底加载。只容忍 .env 缺失，其余错误原样抛出。
try {
  process.loadEnvFile(path.resolve(__dirname, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

/** docker-compose.test.yml 的固定测试凭据（非生产值，桶只在回环上暴露） */
const MINIO = {
  TEST_S3_ENDPOINT: "http://127.0.0.1:9000",
  TEST_S3_BUCKET: "noxrea-test",
  TEST_S3_REGION: "us-east-1",
  TEST_S3_ACCESS_KEY_ID: "noxrea-test",
  TEST_S3_SECRET_ACCESS_KEY: "noxrea-test-secret",
  TEST_S3_PROVIDER: "minio",
};
for (const [name, value] of Object.entries(MINIO)) {
  process.env[name] ??= value;
}

export default defineConfig({
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "server"),
    },
  },
  test: {
    environment: "node",
    include: ["server/__tests__/services/storage/s3.integration.test.ts"],
    // 契约测试不碰数据库：不挂 globalSetup（否则会要求 TEST_DATABASE_URL）
    testTimeout: 60_000,
  },
});
