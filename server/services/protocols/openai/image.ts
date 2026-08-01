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

export class OpenAiImageProtocol implements ProtocolService {
  readonly name = "openai_image";

  buildImageRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    // 有参考图（图生图/编辑）→ /images/edits，否则 → /images/generations
    // 检查 mapping 前后两种字段名：ref_images（原始）或 images（mapping 后）
    const refImages = body.ref_images ?? body.images;
    const hasRef = Array.isArray(refImages) && refImages.length > 0;
    const endpoint = hasRef ? "/images/edits" : "/images/generations";

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
          urls.push(`data:image/png;base64,${b64}`);
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

  /** 提取图片 URL（对齐 Python _extract_image_result） */
  private _extractImageUrls(payload: Record<string, unknown>): string[] {
    const urls: string[] = [];

    // 标准格式：data[].url / data[].b64_json
    const items = payload.data as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const b64 = item.b64_json as string | undefined;
        if (b64) { urls.push(`data:image/png;base64,${b64}`); continue; }
        const u = item.url as string | undefined;
        if (u) urls.push(u);
      }
    }

    // 兜底格式：result.images[].url（url 可能是字符串或数组）
    if (urls.length === 0) {
      const result = payload.result as Record<string, unknown> | undefined;
      if (result && typeof result === "object") {
        const images = result.images as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(images)) {
          for (const img of images) {
            if (!img || typeof img !== "object") continue;
            const urlVal = img.url;
            if (Array.isArray(urlVal)) {
              for (const u of urlVal) if (typeof u === "string") urls.push(u);
            } else if (typeof urlVal === "string") {
              urls.push(urlVal);
            }
          }
        }
      }
    }

    return urls;
  }
}
