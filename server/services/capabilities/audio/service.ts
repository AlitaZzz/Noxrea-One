// ── Audio Capability Service（对应 backend/app/services/capabilities/audio/service.py） ──

import {
  registerCapability,
  type CapabilityService,
  type CapabilityContext,
  type CapabilityParams,
} from "@server/services/capabilities/base";
import { getProtocol } from "@server/services/protocols/base";
import { build } from "@server/services/request-builder/engine";
import { fetchWithTimeout, getWorkerApiTimeout } from "@server/core/http-client";
import { logEvent, summarizeText, summarizeBody } from "@server/core/logger/utils";
import { computeBufferHash, sniffMime, normalizeExt } from "@server/services/storage/hash";
import { buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { localStorage } from "@server/services/storage/backends/local";
import type { GenerationResult } from "@server/schemas/result";
import path from "path";
import fs from "fs/promises";

class AudioCapabilityService implements CapabilityService {
  readonly name = "audio";

  async generate(
    ctx: CapabilityContext,
    params: CapabilityParams
  ): Promise<GenerationResult> {
    const protocol = getProtocol(ctx.protocol);
    if (!protocol?.buildAudioRequest) {
      throw new Error(`Protocol ${ctx.protocol} does not support audio generation`);
    }

    const body = build({
      params,
      modelName: ctx.model,
      capability: "audio",
      protocol: ctx.protocol,
      channelConfig: ctx.config,
      taskId: ctx.taskId,
    });

    logEvent("capability.audio", {
      stage: "params_raw",
      taskId: ctx.taskId,
      params: { ...params, prompt: summarizeText(params.prompt) },
      model: ctx.model,
      protocol: ctx.protocol,
    });

    const req = protocol.buildAudioRequest(ctx.baseUrl, ctx.apiKey, body);

    logEvent("capability.audio", {
      stage: "dispatch",
      taskId: ctx.taskId,
      upstream: {
        url: req.url,
        method: req.method,
        headers: { ...req.headers, Authorization: "Bearer ***" },
        body: summarizeBody(req.body),
      },
    });

    const response = await fetchWithTimeout(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      timeoutMs: getWorkerApiTimeout(),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`Audio generation failed: ${response.status} ${errBody}`);
    }

    // TTS 可能返回二进制数据 — 直接落盘为本地文件
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("audio") || contentType.includes("octet-stream")) {
      const blob = await response.blob();
      const buffer = Buffer.from(await blob.arrayBuffer());
      const hash = computeBufferHash(buffer);
      const { mime, ext: sniffedExt } = sniffMime(buffer.slice(0, 16));
      const fileExt = normalizeExt(sniffedExt) || ".mp3";
      const storageKey = buildStorageKey(ctx.userId, hash, fileExt);
      const targetPath = path.resolve(localStorage.baseDir, storageKey);

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, buffer);

      await persistFileObject({
        userId: ctx.userId,
        hash,
        size: buffer.length,
        mimeType: mime,
        ext: fileExt,
        source: "ai_generated",
      });

      logEvent("capability.audio", {
        stage: "binary_saved",
        taskId: ctx.taskId,
        key: storageKey,
        size: buffer.length,
      });

      return { urls: [storageKey], text: undefined };
    }

    const data = await response.json();
    const parsed = protocol.parseAudioResponse
      ? protocol.parseAudioResponse(data)
      : { urls: [] };

    return { urls: parsed.urls, text: parsed.text };
  }
}

registerCapability("audio", new AudioCapabilityService());
