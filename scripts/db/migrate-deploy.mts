/**
 * 部署 / 开发期迁移应用入口（specs/pglite-removal.md）。
 *
 * `prisma migrate deploy` 只应用未执行的迁移（幂等、不做 drift 检测与重置），
 * 是生产 entrypoint / 部署流水线与开发机共用的唯一应用路径。
 *
 * Prisma 7 CLI 不再自动加载 .env，本脚本由 npm script 以 `tsx --env-file=.env`
 * 启动（开发机），容器内 entrypoint 已 source /app/.env 后调用。
 */
import { assertDatabaseUrl } from "../../server/core/database/connection-string";
import { failWithPrismaError, runPrisma } from "../lib/prisma-cli.mts";

try {
  assertDatabaseUrl();
  runPrisma(["migrate", "deploy"]);
} catch (err) {
  failWithPrismaError("迁移应用失败", err);
}
