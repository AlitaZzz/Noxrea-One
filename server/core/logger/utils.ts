/**
 * 结构化日志工具。
 * 在统一日志之上提供事件记录与 base64 内容脱敏等辅助能力。
 */
import { logger } from "./index";

/**
 * base64 data URL 匹配模式：data:...;base64,...
 */
const DATA_URL_RE = /^data:[^;]*;base64,[A-Za-z0-9+/=]+$/;

/**
 * 脱敏字符串中的 base64 内容。
 * 检测 data:...;base64,... 模式并替换为占位符。
 */
function sanitizeString(v: string, maxLen = 200): string {
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
  // 长文本截断
  if (v.length > maxLen) {
    return v.slice(0, maxLen) + "...";
  }
  return v;
}

/**
 * 结构化日志事件。
 * 格式：[module] stage=xxx task=xxx | key=val | ...
 *
 * 横幅（banner）：当 fields.banner 为 true 时，额外输出一行分隔线，
 * 用于标记关键节点（如请求开始/结束、转译完成），对齐外部服务的阶段分隔风格。
 * 横幅内容取自 fields.bannerTitle（缺省回退到 stage 或 module）。
 */
export function logEvent(
  module: string,
  fields: {
    taskId?: string | null;
    stage?: string | null;
    banner?: boolean;
    bannerTitle?: string;
    bannerAtEnd?: boolean;
    level?: "info" | "debug" | "warn" | "error";
    /** 字符串/对象字段的最大输出长度，Infinity 表示不截断（默认字符串 200、对象 300） */
    maxLen?: number;
    [key: string]: unknown;
  }
): void {
  const level = fields.level ?? "info";
  const maxLen = fields.maxLen;
  const parts: string[] = [];

  if (fields.taskId) parts.push(`task=${fields.taskId}`);
  if (fields.stage) parts.push(`stage=${fields.stage}`);

  for (const [k, v] of Object.entries(fields)) {
    if (k === "taskId" || k === "stage" || k === "banner" || k === "bannerTitle" || k === "bannerAtEnd" || k === "level" || k === "maxLen") continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "boolean") {
      parts.push(`${k}=${v ? "true" : "false"}`);
    } else if (typeof v === "string") {
      parts.push(`${k}=${sanitizeString(v, maxLen ?? 200)}`);
    } else {
      // 对象/数组 → JSON.stringify 后再脱敏 base64
      const raw = JSON.stringify(v);
      parts.push(`${k}=${sanitizeString(raw, maxLen ?? 300)}`);
    }
  }

  const msg = `[${module}] ${parts.join(" | ")}`;

  const emitBanner = () => {
    const title = fields.bannerTitle ?? fields.stage ?? module;
    const bar = "═".repeat(Math.min(60, Math.max(20, title.length + 8)));
    logger.info(bar);
    logger.info(`═ ${title} ═`);
    logger.info(bar);
  };

  if (fields.banner && fields.bannerAtEnd) {
    // banner 后置：先正文，后 banner（banner 成为最后一条）
    logger[level](msg);
    emitBanner();
  } else {
    // 默认：banner 前置，正文在后
    if (fields.banner) emitBanner();
    logger[level](msg);
  }
}

/**
 * 分类错误：返回 [类别, 是否可重试]
 * 错误分类
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
 * 响应体摘要
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
 * 文本摘要
 */
export function summarizeText(text: string | null | undefined): string {
  if (!text) return "";
  if (text.length <= 80) return text;
  return text.slice(0, 77) + "...";
}
