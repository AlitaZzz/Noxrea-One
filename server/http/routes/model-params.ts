/**
 * 模型参数路由。
 * 提供当前模型参数配置查询接口。
 * 返回前剥离后端内部字段（mapping / channels），仅暴露前端渲染所需的 fields / capabilities / allowedFields。
 */
import { Hono } from "hono";
import { loadModelParams } from "@server/services/model-config";
import { ok } from "@server/core/response";

const router = new Hono();

/** 后端内部字段名：剥离映射规则、渠道端点与 endpoint 路由，不暴露给前端 */
const INTERNAL_KEYS = new Set(["mapping", "channels", "_endpoints"]);

/**
 * 递归剥离后端内部字段。
 * 递归遍历整棵配置树：对象按 key 过滤，数组逐元素处理。
 * 相比原来「只剥一层」的写法，无论敏感字段出现在哪一层都会被剥离；
 * 同时数组保持数组形态（原实现会把数组经 Object.fromEntries 转成索引对象）。
 */
export function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(strip);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      if (INTERNAL_KEYS.has(key)) continue;
      out[key] = strip(val);
    }
    return out;
  }
  return value;
}

function stripInternal(raw: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return strip(raw) as Record<string, Record<string, unknown>>;
}

router.get("/api/model-params", (c) => {
  const params = loadModelParams();
  return c.json(ok(stripInternal(params)));
});

export { router };
