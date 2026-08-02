import { Hono } from "hono";
import { ok } from "@server/core/response";
import { router as authRouter } from "./routes/auth";
import { router as modelConfigRouter } from "./routes/model-config";
import { router as canvasRouter } from "./routes/canvas";
import { router as assetsRouter } from "./routes/assets";
import { router as generateRouter } from "./routes/generate";
import { router as modelsRouter } from "./routes/models";

// ── Hono 应用实例 ──
const app = new Hono();

// 健康检查
app.get("/api/health", (c) => c.json(ok({ status: "ok" })));

// 路由注册
app.route("/", authRouter);
app.route("/", modelConfigRouter);
app.route("/", canvasRouter);
app.route("/", assetsRouter);
app.route("/", generateRouter);
app.route("/", modelsRouter);

// 404
app.notFound((c) => c.json({ detail: "Not Found" }, 404));

// 全局错误处理
app.onError((err, c) => {
  return c.json({ detail: err.message ?? "Internal Server Error" }, 500);
});

export { app };
