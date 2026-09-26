/**
 * OpenAI 协议共享解析核心。
 * image.ts / video.ts 共用的轮询端点解析与产物提取逻辑（消除两文件重复实现）。
 *
 * 上游返回结构不可控（各渠道响应形态各异且无契约），无法按固定字段路径解析，
 * 成败判定同为证据制且规则收敛在 tasks/failure：
 *  - 失败证据（状态词 / 错误专用键，判定先于产物扫描，错误详情中的 URL 不会被判成产物）；
 *  - 产物证据（整树 URL 扫描 + 裸 base64 字段兜底）。
 * 两者皆无才视为 pending。
 */

import type { PollResult } from "../base";
import {
  extractUpstreamMessage,
  normalizeStatus,
  scanErrorEvidence,
  scanFailureStatus,
  walkResponseTree,
} from "@server/services/tasks/failure";

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

/**
 * 从 JSON 树中提取所有 https:// 和 data: 开头的 URL。
 * 递归遍历字段值（prompt / prompts 回显在 walkResponseTree 统一跳过），
 * 避免请求参数回显中的 URL 被误判为产物地址。
 */
export function scanUrls(root: unknown): string[] {
  const urls: string[] = [];
  const re = /(?:https?:\/\/|data:)[^\s"',;}\]<>]+/g;
  walkResponseTree(root, null, (_key, value) => {
    if (typeof value !== "string") return;
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
      const u = match[0].replace(/[)\]}>.,;!?]+$/, "");
      if (!urls.includes(u)) urls.push(u);
    }
  });
  return urls;
}

/**
 * 裸 base64 兜底：正则无法识别不带 data: 前缀的裸 base64，
 * 故按字段名（b64_json / b64）递归定位后补 MIME 前缀。
 */
export function extractB64Fields(root: unknown, prefix: string): string[] {
  const result: string[] = [];
  walkResponseTree(root, null, (key, value) => {
    if ((key === "b64_json" || key === "b64") && typeof value === "string" && value.length > 0) {
      result.push(value.startsWith("data:") ? value : `${prefix}${value}`);
    }
  });
  return result;
}

/** 提交响应的同步产物解析：URL 扫描 + 裸 base64 兜底 */
export function parseScanSyncResult(response: unknown, b64Mime: string): { urls: string[] } {
  const urls = scanUrls(response);
  urls.push(...extractB64Fields(response, b64Mime));
  return { urls };
}

/**
 * 轮询响应解析：失败证据（状态词 / 错误专用键）优先，其次产物扫描，均无则 pending。
 * 判定规则与文案提取统一在 tasks/failure，本函数只做证据编排。
 */
export function parseScanPollResult(data: unknown, b64Mime: string): PollResult {
  const payload = data as Record<string, unknown>;
  if (!payload || typeof payload !== "object") {
    return { status: "pending", urls: [] };
  }

  if (scanFailureStatus(payload) !== null || scanErrorEvidence(payload) !== null) {
    return {
      status: "failed",
      urls: [],
      error: extractUpstreamMessage(payload) || "Upstream task failed",
    };
  }

  // URL 扫描兜底：只要能扫描到产物 URL 就视为完成
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
