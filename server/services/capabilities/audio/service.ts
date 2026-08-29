/**
 * 音频能力服务。
 * 实现音频生成能力，组装协议请求并调用上游补全，支持结果回传与日志脱敏。
 */

import {
  registerCapability,
  type CapabilityService,
  type CapabilityContext,
  type CapabilityParams,
} from "@server/services/capabilities/base";
import { getProtocol } from "@server/services/protocols/base";
import { build } from "@server/services/request-builder/engine";
import { fetchWithTimeout, getWorkerApiTimeout } from "@server/core/http-client";
import { logEvent } from "@server/core/logger/utils";
import { computeBufferHash, sniffMime, normalizeExt } from "@server/services/storage/hash";
import { buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { localStorage } from "@server/services/storage/backends/local";
import {
  GenerationFailureError,
  extractUpstreamMessage,
} from "@server/core/errors/task-failure";
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
      baseUrl: ctx.baseUrl,
      taskId: ctx.taskId,
    });

    const req = protocol.buildAudioRequest(ctx.baseUrl, ctx.apiKey, body);

    // 转译完成阶段（对标外部服务的"转译完成, 返回 plan"）
    logEvent("capability.audio", {
      banner: true,
      bannerTitle: "音频转译完成",
      stage: "translation_done",
      taskId: ctx.taskId,
      url: req.url,
      method: req.method,
      body: req.body,
    });

    const response = await fetchWithTimeout(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      timeoutMs: getWorkerApiTimeout(),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      // 原始响应体只进日志；对外优先用上游自带的可读文案，取不到则回退错误码
      logEvent("audio", {
        level: "warn",
        stage: "upstream_error",
        status: response.status,
        body: errBody.slice(0, 500),
      });
      const upstreamMsg = extractUpstreamMessage(errBody);
      throw new GenerationFailureError(
        upstreamMsg || `HTTP ${response.status}`,
        upstreamMsg ? undefined : "generation.upstream_http_error"
      );
    }

    // TTS 可能返回二进制数据 — 直接落盘为本地文件
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("audio") || contentType.includes("octet-stream")) {
      const blob = await response.blob();
      const buffer = Buffer.from(await blob.arrayBuffer());
      const hash = await computeBufferHash(buffer);
      const { mime, ext: sniffedExt } = sniffMime(buffer.subarray(0, 16));
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
        source: "generated",
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
