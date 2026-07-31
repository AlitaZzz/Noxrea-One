// ── 固定参数注入（对应 backend/app/services/request_builder/patch.py） ──

/**
 * 将渠道配置的 extra_body 深度合并到请求参数中。
 * 对应 Python 的 deep_merge。
 */
export function applyPatch(
  params: Record<string, unknown>,
  channelConfig: Record<string, unknown>
): Record<string, unknown> {
  const extraBody = channelConfig.extra_body as Record<string, unknown> | undefined;
  if (!extraBody) return params;

  return deepMerge(params, extraBody);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };

  for (const [key, val] of Object.entries(override)) {
    const baseVal = result[key];

    if (isPlainObject(baseVal) && isPlainObject(val)) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        val as Record<string, unknown>
      );
    } else {
      result[key] = val;
    }
  }

  return result;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}
