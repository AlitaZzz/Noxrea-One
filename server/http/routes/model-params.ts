/**
 * 模型参数路由。
 * 返回已解析（与 _default 按字段合并，与后端 getModelParams 同源）的模型参数配置树，
 * 供前端渲染参数面板；前端不再各自实现合并/兜底逻辑。
 * 返回前剥离后端内部字段（mapping / channels / endpoint 路由 / 注释性元数据），
 * 仅暴露前端渲染所需的 fields / capabilities / allowedFields。
 */
import { Hono } from "hono";
import { buildResolvedClientTree } from "@server/services/model-config";
import { authenticateRequest } from "@server/http/middleware/auth";
import { ok } from "@server/core/response";

const router = new Hono();

/** 后端内部字段名：剥离映射规则、渠道端点与注释性元数据，不暴露给前端 */
const INTERNAL_KEYS = new Set(["mapping", "channels", "_endpoints", "_comment", "_todo_vendors"]);

/**
 * 递归剥离后端内部字段。
 * 递归遍历整棵配置树：对象按 key 过滤，数组逐元素处理。
 * 相比原来「只剥一层」的写法，无论敏感字段出现在哪一层都会被剥离；
 * 同时数组保持数组形态（原实现会把数组经 Object.fromEntries 转成索引对象）。
 */
function strip(value: unknown): unknown {
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

function stripInternal(raw: Record<string, unknown>): Record<string, unknown> {
  return strip(raw) as Record<string, unknown>;
}

router.get("/api/model-params", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const params = buildResolvedClientTree();
  return c.json(ok(stripInternal(params)));
});

export { router };
