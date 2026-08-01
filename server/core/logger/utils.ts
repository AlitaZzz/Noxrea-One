import { logger } from "./index";

// ── 结构化日志工具（对应 logging_config.py） ──

/**
 * base64 data URL 匹配模式：data:...;base64,...
 */
const DATA_URL_RE = /^data:[^;]*;base64,[A-Za-z0-9+/=]+$/;

/**
 * 脱敏字符串中的 base64 内容。
 * 检测 data:...;base64,... 模式并替换为占位符。
 */
function sanitizeString(v: string): string {
  // 如果整串是 data URL → 占位
  if (DATA_URL_RE.test(v)) {
    return `[base64 data, ${v.length} chars]`;
  }
  // 如果包含 data: 子串 → 尝试脱敏（如 JSON 中包含 base64）
  if (v.includes("data:") && v.includes(";base64,")) {
    // 用正则替换所有 data URL 为占位符
    return v.replace(
      /data:[^;]*;base64,[A-Za-z0-9+/=]+/g,
      (match) => `[base64 data, ${match.length} chars]`
    );
  }
  return v;
}

/**
 * 结构化日志事件。
 * 格式：[module] stage=xxx task=xxx | key=val | ...
 */
export function logEvent(
  module: string,
  fields: {
    taskId?: string | null;
    stage?: string | null;
    [key: string]: unknown;
  }
): void {
  const parts: string[] = [];

  if (fields.taskId) parts.push(`task=${fields.taskId}`);
  if (fields.stage) parts.push(`stage=${fields.stage}`);

  for (const [k, v] of Object.entries(fields)) {
    if (k === "taskId" || k === "stage") continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "boolean") {
      parts.push(`${k}=${v ? "true" : "false"}`);
    } else if (typeof v === "string") {
      parts.push(`${k}=${sanitizeString(v)}`);
    } else {
      // 对象/数组 → JSON.stringify 后再脱敏 base64
      const raw = JSON.stringify(v);
      parts.push(`${k}=${sanitizeString(raw)}`);
    }
  }

  const msg = `[${module}] ${parts.join(" | ")}`;
  logger.info(msg);
}

/**
 * 分类错误：返回 [类别, 是否可重试]
 * 对应 Python classify_error
 */
export function classifyError(
  error: string | null | undefined,
  httpStatus?: number | null
): [string, boolean] {
  const e = (error ?? "").toLowerCase();

  if (e.includes("timed out") || e.includes("timeout")) {
    return ["timeout", true];
  }
  if (
    e.includes("content_policy") ||
    e.includes("unsafe") ||
    e.includes("content policy")
  ) {
    return ["content_policy_error", false];
  }
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    return ["invalid_request", false];
  }
  if (httpStatus && httpStatus >= 500) {
    return ["upstream_error", true];
  }
  return ["unknown_error", false];
}

/**
 * 脱敏 body 日志输出（禁止泄漏 apiKey 和大 body）
 * 对应 Python summarizeBody
 */
export function summarizeBody(body: unknown, maxLen = 200): unknown {
  if (!body || typeof body !== "object") return body;

  const sanitized: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (
      lower.includes("api_key") ||
      lower.includes("apikey") ||
      lower === "authorization"
    ) {
      sanitized[k] = "***";
    } else if (typeof v === "string") {
      // base64 data URL → 占位
      if (v.startsWith("data:")) {
        sanitized[k] = `data:...(${v.length} chars)`;
      } else if (v.length > maxLen) {
        sanitized[k] = v.slice(0, maxLen) + "...";
      } else {
        sanitized[k] = v;
      }
    } else if (Array.isArray(v)) {
      // 数组中的 base64 也脱敏
      sanitized[k] = v.map((item) => {
        if (typeof item === "string" && item.startsWith("data:")) {
          return `data:...(${item.length} chars)`;
        }
        if (typeof item === "object" && item) {
          return summarizeBody(item, maxLen);
        }
        return item;
      });
    } else if (typeof v === "object" && v) {
      sanitized[k] = summarizeBody(v, maxLen);
    } else {
      sanitized[k] = v;
    }
  }

  return sanitized;
}

/**
 * 截断长文本日志
 * 对应 Python summarizeText
 */
export function summarizeText(text: string | null | undefined): string {
  if (!text) return "";
  if (text.length <= 80) return text;
  return text.slice(0, 77) + "...";
}
