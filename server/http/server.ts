import { serve, type ServerType } from "@hono/node-server";
import { app } from "./app";
import { getConfig } from "@server/core/config";
import { logEvent } from "@server/core/logger/utils";

let server: ServerType | null = null;

/**
 * 启动 HTTP 服务器
 * @hono/node-server 将 Hono app 挂载到 Node.js http.Server
 */
export function startServer(): Promise<void> {
  const cfg = getConfig();

  return new Promise((resolve) => {
    server = serve(
      {
        fetch: app.fetch,
        port: cfg.SERVER_PORT,
        hostname: cfg.SERVER_HOST,
      },
      (info) => {
        logEvent("http.server", {
          stage: "started",
          port: info.port,
          address: info.address,
        });
        resolve();
      },
    );
  });
}

/**
 * 停止 HTTP 服务器（优雅关闭，不再接受新连接）
 */
export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      logEvent("http.server", { stage: "stopped" });
      resolve();
    });
  });
}
