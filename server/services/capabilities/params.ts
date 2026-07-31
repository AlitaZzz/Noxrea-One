// ── 参数归一化（对应 backend/app/services/capabilities/params.ts） ──

/**
 * 从 task.config 提取业务参数，过滤基础设施字段。
 * 默认值由 model_params.json 的 defaults 提供（executor 中通过 getModelParams 获取并合并）。
 */
export function extractExecutionParams(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const exclude = new Set(["channel_id", "protocol", "capability", "model", "type", "node_id"]);
  const params: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(config)) {
    if (!exclude.has(key)) {
      params[key] = val;
    }
  }

  return params;
}
