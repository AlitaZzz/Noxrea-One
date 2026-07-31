// ── 背景移除推理服务调用（对应 backend/app/services/inference/bg_removal.py） ──

import { getConfig } from "@server/core/config";
import { fetchWithTimeout } from "@server/core/http";
import { logEvent } from "@server/core/logger/utils";

export interface BgRemovalInput {
  imageUrl: string;
  taskId?: string;
}

export interface BgRemovalOutput {
  resultUrl: string;
}

/**
 * 调用推理服务进行背景移除
 */
export async function callBgRemoval(input: BgRemovalInput): Promise<BgRemovalOutput> {
  const cfg = getConfig();
  const baseUrl = cfg.INFERENCE_SERVICE_URL.replace(/\/+$/, "");
  const apiKey = cfg.INFERENCE_SERVICE_API_KEY;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  logEvent("inference.bg_removal", {
    stage: "calling",
    taskId: input.taskId,
  });

  const response = await fetchWithTimeout(`${baseUrl}/remove-bg`, {
    method: "POST",
    headers,
    body: JSON.stringify({ image_url: input.imageUrl }),
    timeoutMs: cfg.HTTP_TIMEOUT_INFERENCE * 1000,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`BgRemoval inference failed: ${response.status} ${errBody}`);
  }

  const data = (await response.json()) as { result_url?: string };

  if (!data.result_url) {
    throw new Error("BgRemoval: no result_url in response");
  }

  return { resultUrl: data.result_url };
}
