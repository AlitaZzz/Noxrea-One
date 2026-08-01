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

export class OpenAiVideoProtocol implements ProtocolService {
  readonly name = "openai_video";

  buildVideoRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    return {
      url: `${baseUrl}/videos`,
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

  extractTaskId(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;

    // 1. 顶层 task_id
    if (d.task_id) return String(d.task_id);

    // 2. data.task_id 或 data[0].task_id
    const inner = d.data;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const tid = (inner as Record<string, unknown>).task_id;
      if (tid) return String(tid);
    } else if (Array.isArray(inner) && inner.length > 0 && typeof inner[0] === "object") {
      const tid = (inner[0] as Record<string, unknown>).task_id;
      if (tid) return String(tid);
    }

    // 3. "id" 字段：仅当 status 为 pending 类时才接受
    const idVal = d.id;
    if (idVal) {
      const status = normalizeStatus(String(d.status ?? ""));
      if (status === "pending") return String(idVal);
    }

    return null;
  }

  buildPollUrl(baseUrl: string, upstreamTaskId: string): string {
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

  /** 提取视频 URL */
  private _extractVideoUrls(payload: Record<string, unknown>): string[] {
    const urls: string[] = [];

    // 标准格式：data[].url
    const items = payload.data as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const u = item.url as string | undefined;
        if (u) urls.push(u);
      }
    }

    // 兜底格式：result.video_url / video_url
    if (urls.length === 0) {
      const result = payload.result as Record<string, unknown> | undefined;
      const videoUrl = result?.video_url ?? payload.video_url;
      if (typeof videoUrl === "string") urls.push(videoUrl);
    }

    return urls;
  }
}
