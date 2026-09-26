/**
 * OpenAI 协议共享解析核心。
 * image.ts / video.ts 共用的状态归一化、轮询端点解析与产物提取逻辑（消除两文件重复实现）。
 *
 * 产物提取采用整树 URL 扫描：上游返回结构不可控（各渠道响应形态各异且无契约），
 * 无法按固定字段路径解析，故扫描全部字符串值兜底。已知的风险控制：
 * - 键名为 prompt / prompts 的值不参与扫描（用户输入回显，其中的 URL 非产物）；
 * - 状态为 failed 的响应先于扫描返回，错误详情不会被判成产物。
 */

import type { PollResult } from "../base";

const PENDING_STATUSES = new Set([
  "pending", "queued", "submitted", "processing", "running", "started", "in_progress",
]);

const COMPLETED_STATUSES = new Set([
  "success", "succeeded", "completed", "done", "ready", "finished",
]);

const FAILED_STATUSES = new Set([
  "failed", "error", "cancelled", "canceled", "timeout", "aborted", "invalid",
]);

/** 归一化上游状态到 pending/completed/failed（无法识别时原样返回小写） */
export function normalizeStatus(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (PENDING_STATUSES.has(s)) return "pending";
  if (COMPLETED_STATUSES.has(s)) return "completed";
  if (FAILED_STATUSES.has(s)) return "failed";
  return s;
}

/**
 * 从 channelConfig.protocol.endpoints 提取轮询占位符名。
 * 按能力优先读 {capability}.poll（如 image.poll / video.poll），回退通用 poll。
 */
export function getPollFieldName(
  channelConfig?: Record<string, unknown>,
  capability?: string
): string | null {
  const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;
  const pollPath = (capability && endpoints?.[`${capability}.poll`]) || endpoints?.["poll"];
  if (!pollPath) return null;
  // 跳过 {model} 占位符，取第一个真正的任务 ID 字段占位符（如 {video_id} / {task_id}）
  const matches = pollPath.match(/\{([^}]+)\}/g);
  const field = matches?.map((m) => m.slice(1, -1)).find((name) => name !== "model");
  return field ?? null;
}

/** 从 channelConfig.protocol.endpoints 提取轮询路径（能力优先，回退通用 poll）。 */
function getPollPath(
  channelConfig?: Record<string, unknown>,
  capability?: string
): string | undefined {
  const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;
  return (capability && endpoints?.[`${capability}.poll`]) || endpoints?.["poll"];
}

/**
 * 构造轮询 URL（image / video 共用，仅能力名不同）。
 * 自定义路径三种形态：完整 URL 直接替换占位符；含 {xxx} 占位符拼接 baseUrl 后
 * 替换；纯路径段追加任务 ID。占位符替换规则：{model} 走请求模型名，
 * 其余（如 {video_id} / {task_id}）走任务 ID。
 */
export function buildOpenAiPollUrl(
  baseUrl: string,
  upstreamTaskId: string,
  channelConfig?: Record<string, unknown>,
  capability?: string,
  model?: string
): string {
  const customPath = getPollPath(channelConfig, capability);
  const fill = (path: string) =>
    path.replace(/\{([^}]+)\}/g, (_, name: string) => (name === "model" ? (model ?? "") : upstreamTaskId));
  if (customPath) {
    if (/^https?:\/\//.test(customPath)) {
      return fill(customPath);
    }
    if (/\{[^}]+\}/.test(customPath)) {
      return `${baseUrl}${fill(customPath)}`;
    }
    return `${baseUrl}${customPath}/${upstreamTaskId}`;
  }
  return `${baseUrl}/tasks/${upstreamTaskId}`;
}

/** URL 扫描跳过的键名：prompt 类字段是用户输入回显，其中的 URL 不是产物地址 */
const URL_SCAN_SKIP_KEYS = new Set(["prompt", "prompts"]);

/**
 * 从 JSON 树中提取所有 https:// 和 data: 开头的 URL。
 * 递归遍历字段值；键名为 prompt / prompts 的值不参与扫描，
 * 避免请求参数回显中的 URL 被误判为产物地址。
 */
export function scanUrls(root: unknown): string[] {
  const urls: string[] = [];
  const re = /(?:https?:\/\/|data:)[^\s"',;}\]<>]+/g;
  const scanString = (s: string) => {
    let match: RegExpExecArray | null;
    while ((match = re.exec(s)) !== null) {
      const u = match[0].replace(/[)\]}>.,;!?]+$/, "");
      if (!urls.includes(u)) urls.push(u);
    }
  };
  const visit = (n: unknown) => {
    if (typeof n === "string") {
      scanString(n);
      return;
    }
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    const obj = n as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (URL_SCAN_SKIP_KEYS.has(key)) continue;
      visit(obj[key]);
    }
  };
  visit(root);
  return urls;
}

/**
 * 裸 base64 兜底：正则无法识别不带 data: 前缀的裸 base64，
 * 故按字段名（b64_json / b64）递归定位后补 MIME 前缀。
 */
export function extractB64Fields(node: unknown, prefix: string): string[] {
  const result: string[] = [];
  const visit = (n: unknown) => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    const obj = n as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if ((key === "b64_json" || key === "b64") && typeof val === "string" && val.length > 0) {
        result.push(val.startsWith("data:") ? val : `${prefix}${val}`);
      } else if (val !== null && typeof val === "object") {
        visit(val);
      }
    }
  };
  visit(node);
  return result;
}

/** 提交响应的同步产物解析：URL 扫描 + 裸 base64 兜底 */
export function parseScanSyncResult(response: unknown, b64Mime: string): { urls: string[] } {
  const urls = scanUrls(response);
  urls.push(...extractB64Fields(response, b64Mime));
  return { urls };
}

/** 轮询响应解析：状态判定优先，其次 URL 扫描兜底 */
export function parseScanPollResult(data: unknown, b64Mime: string): PollResult {
  const payload = data as Record<string, unknown>;
  if (!payload || typeof payload !== "object") {
    return { status: "pending", urls: [] };
  }

  const status = normalizeStatus(String(payload.status ?? ""));

  if (status === "failed") {
    const err = payload.error ?? payload.message ?? "Unknown error";
    const errMsg =
      typeof err === "object"
        ? String((err as Record<string, unknown>).message ?? "Unknown error")
        : String(err);
    // 限长：上游文案会直接展示给用户，避免超长内容撑破提示框
    return { status: "failed", urls: [], error: errMsg.slice(0, 200) };
  }

  // URL 扫描兜底：上游返回结构不可控，只要能扫描到产物 URL 就视为完成
  const urls = scanUrls(payload);
  urls.push(...extractB64Fields(payload, b64Mime));
  if (urls.length > 0) return { status: "completed", urls };

  return { status: "pending", urls: [] };
}

/**
 * 从响应中提取上游异步 task_id（image/video 共用，仅能力名不同）。
 * 优先级：poll 路径占位符字段 → task_id → pending 状态下的 id。
 */
export function extractOpenAiTaskId(
  data: unknown,
  channelConfig?: Record<string, unknown>,
  capability?: string
): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  // 0. 从 poll 路径占位符推导字段名（如 {video_id} → "video_id"），优先匹配
  const pollField = getPollFieldName(channelConfig, capability);

  // 辅助：按指定字段名在顶层和 data 嵌套中查找
  const findField = (fieldName: string): string | null => {
    // 顶层
    if (d[fieldName]) return String(d[fieldName]);
    // data.{fieldName}
    const inner = d.data;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const val = (inner as Record<string, unknown>)[fieldName];
      if (val) return String(val);
    } else if (Array.isArray(inner) && inner.length > 0 && typeof inner[0] === "object") {
      const val = (inner[0] as Record<string, unknown>)[fieldName];
      if (val) return String(val);
    }
    return null;
  };

  // 1. 如果 poll 路径指定了字段名（如 task_id / video_id / request_id），优先使用
  if (pollField) {
    const found = findField(pollField);
    if (found) return found;
  }

  // 2. 兜底：task_id
  const taskId = findField("task_id");
  if (taskId) return taskId;

  // 3. "id" 字段：仅当 status 为 pending 类时才接受
  const idVal = d.id;
  if (idVal) {
    const status = normalizeStatus(String(d.status ?? ""));
    if (status === "pending") return String(idVal);
  }

  return null;
}
