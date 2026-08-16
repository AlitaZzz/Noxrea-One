/**
 * 参数变换。
 * 根据 model-params.json 的 transforms 配置执行值变换，支持 base64 与查表。
 */

/**
 * 从 model-params.json 的 transforms 配置执行值变换。
 *
 * 支持的变换类型：
 *   - "base64": URL 列表 → base64 data URL
 *   - "lookup": 查表变换（支持 composite 多字段联合查表）
 *
 * Returns: (body, consumed_fields) — consumed 记录被 composite 消费的非目标字段
 */
export function applyTransforms(
  body: Record<string, unknown>,
  transforms: Record<string, unknown>
): { body: Record<string, unknown>; consumed: Set<string> } {
  const result = { ...body };
  const consumedTotal = new Set<string>();

  for (const [field, spec] of Object.entries(transforms)) {
    const { type, params } = parseSpec(spec);
    if (!type) continue;

    const value = getNested(result, field);
    if (value === undefined || value === null) continue;

    if (type === "lookup") {
      const table = (params.table as Record<string, string | string[]>) ?? {};
      const composite = params.composite as string[] | undefined;

      if (composite) {
        // 多字段联合查表：key = "ratio|resolution"
        const key = composite.map((f) => String(result[f] ?? "")).join("|");
        const lookupResult = table[key] ?? value;
        const finalValue = Array.isArray(lookupResult) ? lookupResult[0] : lookupResult;
        setNested(result, field, finalValue);
        // 标记 composite 中非目标字段为已消费
        for (const f of composite) {
          if (f !== field) consumedTotal.add(f);
        }
      } else {
        // 单字段查表
        const strVal = String(value);
        const lookupResult = table[strVal] ?? value;
        const finalValue = Array.isArray(lookupResult) ? lookupResult[0] : lookupResult;
        setNested(result, field, finalValue);
      }
    } else if (type === "base64") {
      // base64 变换：占位实现，正式使用时在 executor 层处理
      setNested(result, field, value);
    }
  }

  return { body: result, consumed: consumedTotal };
}

interface TransformSpec {
  type: string | null;
  params: Record<string, unknown>;
}

function parseSpec(spec: unknown): TransformSpec {
  if (typeof spec === "string") return { type: spec, params: {} };
  if (typeof spec === "object" && spec !== null) {
    const obj = spec as Record<string, unknown>;
    return { type: (obj.type as string) ?? null, params: obj };
  }
  return { type: null, params: {} };
}

function getNested(d: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = d;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNested(d: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = d;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
