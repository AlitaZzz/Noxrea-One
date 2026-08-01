// ── OpenAI 图片生成协议 ──

import type {
  ProtocolRequestResult,
  ProtocolResponse,
  ProtocolService,
  PollResult,
} from "@server/services/protocols/base";

/** pending 状态集合（对齐 Python PENDING_STATUSES） */
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

export class OpenAiImageProtocol implements ProtocolService {
  readonly name = "openai_image";

  buildImageRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    channelConfig?: Record<string, unknown>
  ): ProtocolRequestResult {
    // 解析 channel config 中的 endpoints
    const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;

    // 有参考图（图生图/编辑）→ /images/edits，否则 → /images/generations
    // 检查 mapping 前后两种字段名：refImages（原始）或 images（mapping 后）
    const refImages = body.refImages ?? body.images;
    const hasRef = Array.isArray(refImages) && refImages.length > 0;

    // 渠道自定义 endpoint 优先，否则用默认逻辑
    let endpoint: string;
    if (hasRef) {
      endpoint = endpoints?.["image.edits"] ?? "/images/edits";
    } else {
      endpoint = endpoints?.["image.generations"] ?? "/images/generations";
    }

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

  parseImageResponse(response: unknown): ProtocolResponse {
    const data = response as Record<string, unknown>;
    const resultData = data?.data as Array<Record<string, unknown>> | undefined;

    const urls: string[] = [];
    if (Array.isArray(resultData)) {
      for (const item of resultData) {
        // b64_json 优先（避免 URL 过期），回退 url
        const b64 = item?.b64_json as string | undefined;
        const url = item?.url as string | undefined;
        if (b64) {
          // 防止上游已自带 data: 前缀导致双重包装
          urls.push(b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`);
        } else if (url) {
          urls.push(url);
        }
      }
    }

    // 兜底：部分代理返回 { images: [{ url: ... }] }
    if (urls.length === 0) {
      const images = data?.images as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(images)) {
        for (const img of images) {
          const url = img?.url as string | undefined;
          if (url) urls.push(url);
        }
      }
    }

    return { urls };
  }

  // ── 异步任务支持（对齐 Python OpenAIBaseProtocol） ──

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
    // 1. unwrap：{ code: 200, data: {...} } → 提取内层 data
    let payload = data as Record<string, unknown>;
    if (!payload || typeof payload !== "object") {
      return { status: "pending", urls: [] };
    }
    // unwrap 包裹层（对齐 Python _unwrap）
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      payload = payload.data as Record<string, unknown>;
    }

    const status = normalizeStatus(String(payload.status ?? ""));

    if (status === "completed") {
      const extracted = this._extractImageUrls(payload);
      if (extracted.length > 0) return { status: "completed", urls: extracted };

      // 确认 status=completed 但无 data → 查看 output/result 兜底
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

    // status-agnostic 兜底：只要能提取到图片数据就视为完成
    let extracted = this._extractImageUrls(payload);
    if (extracted.length === 0 && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      // 双重包裹
      extracted = this._extractImageUrls(payload.data as Record<string, unknown>);
    }
    if (extracted.length > 0) return { status: "completed", urls: extracted };

    return { status: "pending", urls: [] };
  }

  /** 提取图片 URL：扫描 JSON 中所有 https:// 和 data: 开头的资源 */
  private _extractImageUrls(payload: Record<string, unknown>): string[] {
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
