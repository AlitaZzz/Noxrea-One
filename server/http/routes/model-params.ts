/**
 * 模型参数路由。
 * 提供当前模型参数配置查询接口。
 */
import { Hono } from "hono";
import { loadModelParams } from "@server/services/model-config";
import { ok } from "@server/core/response";

const router = new Hono();

router.get("/api/model-params", (c) => {
  const params = loadModelParams();
  return c.json(ok(params));
});

export { router };
