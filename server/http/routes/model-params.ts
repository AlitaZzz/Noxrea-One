/**
 * 模型参数路由。
 * 提供当前模型参数配置查询接口。
 * 返回前剥离后端内部字段（mapping / channels），仅暴露前端渲染所需的 fields / capabilities / allowedFields。
 */
import { Hono } from "hono";
import { loadModelParams } from "@server/services/model-config";
import { ok } from "@server/core/response";

const router = new Hono();

/** 剥离后端内部字段（字段映射与渠道端点不暴露给前端） */
function stripInternal(raw: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [modelKey, caps] of Object.entries(raw)) {
    const capsOut: Record<string, unknown> = {};
    for (const [capKey, capVal] of Object.entries(caps)) {
      if (!capVal || typeof capVal !== "object") {
        capsOut[capKey] = capVal;
        continue;
      }
      const { mapping: _m, channels: _c, ...rest } = capVal as Record<string, unknown>;
      capsOut[capKey] = rest;
    }
    out[modelKey] = capsOut;
  }
  return out;
}

router.get("/api/model-params", (c) => {
  const params = loadModelParams();
  return c.json(ok(stripInternal(params)));
});

export { router };
