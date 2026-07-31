import pino from "pino";
import { getConfig } from "@server/core/config";

// ── 全局单例 ──

const globalForPino = globalThis as unknown as {
  __noxreaLogger?: pino.Logger;
};

function createLogger(): pino.Logger {
  const cfg = getConfig();
  const level = cfg.LOG_LEVEL.toLowerCase();

  const isDev = process.env.NODE_ENV !== "production";

  return pino({
    level,
    ...(isDev
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss",
              ignore: "pid,hostname",
            },
          },
        }
      : {}),
  });
}

export const logger: pino.Logger =
  globalForPino.__noxreaLogger ?? createLogger();

if (process.env.NODE_ENV !== "production") {
  globalForPino.__noxreaLogger = logger;
}
