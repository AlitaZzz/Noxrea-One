// ── OpenAI 视频生成协议 ──

import type {
  ProtocolRequestResult,
  ProtocolResponse,
  ProtocolService,
  PollResult,
} from "@server/services/protocols/base";

/** pending 状态集合 */
const PENDING_STATUSES = new Set([
  "pending", "queued", "submitted", "processing", "running", "started", "in_progress",
]);

/** 归一化上游状态到 pending/completed/failed */
function normalizeStatus(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (PENDING_STATUSES.has(s)) return "pending";
  if (new Set(["success", "succeeded", "completed", "done", "ready", "finished"]).has(s)) return "completed";
  if (new Set(["failed", "error", "cancelled", "canceled", "timeout", "aborted"]).has(s)) return "failed";
  return s;
}

/** 从 channelConfig.protocol.endpoints.poll 中提取占位符名，如 "/videos/{task_id}" → "task_id" */
function getPollFieldName(channelConfig?: Record<string, unknown>): string | null {
  const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;
  const pollPath = endpoints?.["poll"];
  if (!pollPath) return null;
  const match = pollPath.match(/\{([^}]+)\}/);
  return match ? match[1] : null;
}

export class OpenAiVideoProtocol implements ProtocolService {
  readonly name = "openai_video";

  buildVideoRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    channelConfig?: Record<string, unknown>
  ): ProtocolRequestResult {
    const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;
    const endpoint = endpoints?.["video.generations"] ?? "/videos";

    return {
      url: `${baseUrl}${endpoint}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  }

  parseVideoResponse(response: unknown): ProtocolResponse {
    const data = response as Record<string, unknown>;
    const resultData = data?.data as Array<Record<string, unknown>> | undefined;
    const urls: string[] = [];

    if (Array.isArray(resultData)) {
      for (const item of resultData) {
        const url = item?.url as string | undefined;
        if (url) urls.push(url);
      }
    }

    return { urls };
  }

  // ── 异步任务支持（对齐 OpenAiImageProtocol） ──

  extractTaskId(data: unknown, channelConfig?: Record<string, unknown>): string | null {
    if (!data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;

    // 0. 从 poll 路径占位符推导字段名（如 {video_id} → "video_id"），优先匹配
    const pollField = getPollFieldName(channelConfig);

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

  buildPollUrl(baseUrl: string, upstreamTaskId: string, channelConfig?: Record<string, unknown>): string {
    const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;
    const customPath = endpoints?.["poll"];
    if (customPath) {
      // 如果已是完整 URL（含协议头），直接替换占位符返回
      if (/^https?:\/\//.test(customPath)) {
        return customPath.replace(/\{[^}]+\}/, upstreamTaskId);
      }
      // 如果包含 {xxx} 占位符，拼接 baseUrl 后替换
      if (/\{[^}]+\}/.test(customPath)) {
        return `${baseUrl}${customPath.replace(/\{[^}]+\}/, upstreamTaskId)}`;
      }
      // 无占位符：追加到路径末尾
      return `${baseUrl}${customPath}/${upstreamTaskId}`;
    }
    return `${baseUrl}/tasks/${upstreamTaskId}`;
  }

  parsePollResponse(data: unknown): PollResult {
    let payload = data as Record<string, unknown>;
    if (!payload || typeof payload !== "object") {
      return { status: "pending", urls: [] };
    }

    // unwrap 包裹层
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      payload = payload.data as Record<string, unknown>;
    }

    const status = normalizeStatus(String(payload.status ?? ""));

    if (status === "completed") {
      const extracted = this._extractVideoUrls(payload);
      if (extracted.length > 0) return { status: "completed", urls: extracted };

      // 兜底：output/result 字段
      const outputUrls = payload.output ?? payload.result;
      if (typeof outputUrls === "string") return { status: "completed", urls: [outputUrls] };
    }

    if (status === "failed") {
      const err = payload.error ?? payload.message ?? "Unknown error";
      const errMsg =
        typeof err === "object"
          ? String((err as Record<string, unknown>).message ?? "Unknown error")
          : String(err);
      return { status: "failed", urls: [], error: errMsg };
    }

    // status-agnostic 兜底：只要能提取到视频数据就视为完成
    let extracted = this._extractVideoUrls(payload);
    if (extracted.length === 0 && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      extracted = this._extractVideoUrls(payload.data as Record<string, unknown>);
    }
    if (extracted.length > 0) return { status: "completed", urls: extracted };

    return { status: "pending", urls: [] };
  }

  /** 提取视频 URL：扫描 JSON 中所有 https:// 开头的 URL */
  private _extractVideoUrls(payload: Record<string, unknown>): string[] {
    return this._scanUrls(JSON.stringify(payload));
  }

  /** 从字符串中提取所有 https:// 和 data: 开头的 URL */
  private _scanUrls(raw: string): string[] {
    const urls: string[] = [];
    const re = /(?:https?:\/\/|data:)[^\s"',;}\]<>]+/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) {
      const u = match[0].replace(/[)\]}>.,;!?]+$/, "");
      if (!urls.includes(u)) urls.push(u);
    }
    return urls;
  }
}
