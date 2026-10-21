import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * server 侧 vitest 配置（与 web 的测试配置独立，别名 @server 指向 server/）。
 * 运行：npm run test:server
 */

// 测试进程树的 env 注入点。生产由进程入口注入（--env-file=.env / entrypoint source /
// compose -e），config 模块不做 .env 兜底加载（已移除「谁先加载 config 谁改写共享
// process.env」的隐式全局副作用）；测试树等价的入口就是本配置——在主进程求值期加载
// 一次，worker 子进程随后继承。
try {
  process.loadEnvFile(path.resolve(__dirname, ".env"));
} catch (error) {
  // 仅容忍 .env 不存在（如无 .env 的全新克隆，需要 env 的用例由 config schema
  // 校验大声报缺）；其余错误（如格式解析失败）原样抛出，与生产 script 的
  // tsx --env-file=.env 对坏 .env 的大声失败对称。
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export default defineConfig({
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "server"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts"],
  },
});
