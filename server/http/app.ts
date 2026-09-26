/**
 * HTTP 应用装配。
 * 聚合各业务路由、中间件与全局错误处理，构建 Hono 应用实例。
 */
import { Hono } from "hono";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import { requestId } from "./middleware/request-id";
import { jsonBodyLimit } from "./middleware/body-limit";
import { router as authRouter } from "./routes/auth";
import { router as modelConfigRouter } from "./routes/model-config";
import { router as canvasRouter } from "./routes/canvas";
import { router as assetsRouter } from "./routes/assets";
import { router as generateRouter } from "./routes/generate";
import { router as agentRouter } from "./routes/agent";
import { router as modelsRouter } from "./routes/models";
import { router as modelParamsRouter } from "./routes/model-params";
import { router as captureFrameRouter } from "./routes/capture-frame";
import { router as videoProxyRouter } from "./routes/video-proxy";
import { router as frameSpriteRouter } from "./routes/frame-sprite";
import { router as detachAudioRouter } from "./routes/detach-audio";
import { router as extractClipRouter } from "./routes/extract-video-clip";
import { extractAudioClipRouter } from "./routes/extract-audio-clip";
import { applyAudioSpeedRouter } from "./routes/apply-audio-speed";
import { router as cropVideoRouter } from "./routes/crop-video";
import { router as uploadRouter } from "./routes/upload";
import { router as filesRouter } from "./routes/files";

// Hono 应用实例
const app = new Hono();

// 请求 ID：先于所有路由执行，使日志与错误响应都能带上同一标识
app.use("*", requestId());

// JSON 请求体分级上限：画布与 Agent 携带整份画布快照（10MB），资产批量次之（2MB），
// 模型配置/生成任务最小（1MB），认证请求体很小（64KB）。
// /api/files/* 不设全局上限：上传走 multipart 且有 MAX_UPLOAD_SIZE_MB 专用校验。
app.use("/api/canvas/*", jsonBodyLimit(10 * 1024 * 1024));
app.use("/api/agent/*", jsonBodyLimit(10 * 1024 * 1024));
app.use("/api/assets/*", jsonBodyLimit(2 * 1024 * 1024));
app.use("/api/generate/*", jsonBodyLimit(1024 * 1024));
app.use("/api/model-config/*", jsonBodyLimit(1024 * 1024));
app.use("/api/models/*", jsonBodyLimit(1024 * 1024));
app.use("/api/auth/*", jsonBodyLimit(64 * 1024));

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
app.route("/", videoProxyRouter);
app.route("/", frameSpriteRouter);
app.route("/", detachAudioRouter);
app.route("/", extractClipRouter);
app.route("/", extractAudioClipRouter);
app.route("/", applyAudioSpeedRouter);
app.route("/", cropVideoRouter);
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
