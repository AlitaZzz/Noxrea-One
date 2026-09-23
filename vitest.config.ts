import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * server 侧 vitest 配置（与 web 的测试配置独立，别名 @server 指向 server/）。
 * 运行：npm run test:server
 */
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
