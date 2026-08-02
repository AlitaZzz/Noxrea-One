import { Hono } from "hono";
import { ok } from "@server/core/response";

// ── Hono 应用实例 ──
// 路由在后续批次中注册，此处仅创建骨架
const app = new Hono();

// 健康检查
app.get("/api/health", (c) => c.json(ok({ status: "ok" })));

// 404
app.notFound((c) => c.json({ detail: "Not Found" }, 404));

// 全局错误处理
app.onError((err, c) => {
  return c.json({ detail: err.message ?? "Internal Server Error" }, 500);
});

export { app };
