// ── Background Removal Capability（对应 backend/app/services/capabilities/bg_removal/service.py） ──

import {
  registerCapability,
  type CapabilityService,
  type CapabilityContext,
  type CapabilityParams,
} from "@server/services/capabilities/base";
import { fetchWithTimeout, getInferenceTimeout } from "@server/core/http";
import { getConfig } from "@server/core/config";
import { logEvent } from "@server/core/logger/utils";
import type { GenerationResult } from "@server/schemas/result";

class BgRemovalCapabilityService implements CapabilityService {
  readonly name = "bg_removal";

  async generate(
    ctx: CapabilityContext,
    params: CapabilityParams
  ): Promise<GenerationResult> {
    const cfg = getConfig();
    const inferenceUrl = cfg.INFERENCE_SERVICE_URL;
    const apiKey = cfg.INFERENCE_SERVICE_API_KEY;

    // 优先用 ref_images[0]（对齐 Python），回退 image_url
    const refImages = params.ref_images as string[] | undefined;
    const imageUrl = (refImages && refImages.length > 0 ? refImages[0] : null) ?? params.image_url as string | undefined;
    if (!imageUrl) {
      throw new Error("ref_images[0] or image_url is required for background removal");
    }

    logEvent("capability.bg_removal", {
      stage: "dispatch",
      taskId: ctx.taskId,
      imageUrl: imageUrl.slice(0, 120),
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetchWithTimeout(`${inferenceUrl}/remove-bg`, {
      method: "POST",
      headers,
      body: JSON.stringify({ image_url: imageUrl }),
      timeoutMs: getInferenceTimeout(),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`Background removal failed: ${response.status} ${errBody}`);
    }

    const data = (await response.json()) as { result_url?: string; urls?: string[] };

    const urls: string[] = [];
    if (data.result_url) urls.push(data.result_url);
    if (data.urls) urls.push(...data.urls);

    return { urls };
  }
}

registerCapability("bg_removal", new BgRemovalCapabilityService());
