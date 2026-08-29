/**
 * HTTP 应用装配。
 * 聚合各业务路由、中间件与全局错误处理，构建 Hono 应用实例。
 */
import { Hono } from "hono";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import { requestId } from "./middleware/request-id";
import { router as authRouter } from "./routes/auth";
import { router as modelConfigRouter } from "./routes/model-config";
import { router as canvasRouter } from "./routes/canvas";
import { router as assetsRouter } from "./routes/assets";
import { router as generateRouter } from "./routes/generate";
import { router as agentRouter } from "./routes/agent";
import { router as modelsRouter } from "./routes/models";
import { router as modelParamsRouter } from "./routes/model-params";
import { router as captureFrameRouter } from "./routes/capture-frame";
import { router as uploadRouter } from "./routes/upload";
import { router as filesRouter } from "./routes/files";

// Hono 应用实例
const app = new Hono();

// 请求 ID：先于所有路由执行，使日志与错误响应都能带上同一标识
app.use("*", requestId());

// 健康检查
app.get("/api/health", (c) => c.json(ok({ status: "ok" })));

// 路由注册（具体路径优先于通配符 /api/files/*）
app.route("/", authRouter);
app.route("/", modelConfigRouter);
app.route("/", canvasRouter);
app.route("/", assetsRouter);
app.route("/", generateRouter);
app.route("/", agentRouter);
app.route("/", modelsRouter);
app.route("/", modelParamsRouter);
app.route("/", captureFrameRouter);
app.route("/", uploadRouter);
app.route("/", filesRouter);

// 404
app.notFound(() => failCode(404, "common.not_found"));

// 全局错误处理：异常详情只进日志，避免内部信息随响应下发
app.onError((err) => {
  logger.error({ err }, "Unhandled error");
  return failCode(500, "common.internal_error");
});

export { app };
