/**
 * 轮询型能力基类（image / video 共用）。
 *
 * 固化两类能力的公共骨架：请求体管线 → 上游 endpoints 解析 → 请求组装 →
 * 组装完成日志 → submitAndWait（同步优先、异步轮询兜底）→ 终态翻译。
 * 子类只提供三个能力专属钩子：能力名、协议请求构建（含协议方法守卫）、
 * 同步响应解析。
 */

import type { GenerationResult } from "@server/schemas/result";
import type {
  ProtocolRequestResult,
  ProtocolService,
} from "@server/services/protocols/base";
import { getProtocol } from "@server/services/protocols/base";
import { build } from "@server/services/request-builder/engine";
import { resolveProviderEndpoints, hostFromBaseUrl } from "@server/services/model-config";
import { submitAndWait } from "@server/services/tasks/manager";
import {
  GenerationCancelledError,
  GenerationFailureError,
} from "@server/services/tasks/failure";
import { logEvent } from "@server/core/logger/utils";

import type { CapabilityContext, CapabilityParams, CapabilityService } from "./base";

/** 组装完成日志的中文能力名（audio/video 已有同款 banner，image 此前缺失，一并补齐） */
const CAPABILITY_LABELS: Record<string, string> = { image: "图片", video: "视频" };

/** 渠道配置：endpoints 由基类从 model-ui.json 解析后透传给子类 */
export type CapabilityEndpointConfig = Record<string, unknown> | undefined;

export abstract class PollingCapabilityService implements CapabilityService {
  abstract readonly name: string;

  /** request-builder / 上游 endpoints / submitAndWait 使用的能力名 */
  protected abstract readonly capability: string;

  /** submitAndWait 返回 failed 且未携带原因时的兜底文案 */
  protected abstract readonly failFallback: string;

  /** 构建能力专属上游请求（协议方法守卫在此实现；body 已过管线） */
  protected abstract buildRequest(
    protocol: ProtocolService,
    ctx: CapabilityContext,
    params: CapabilityParams,
    body: Record<string, unknown>,
    endpointCfg: CapabilityEndpointConfig
  ): ProtocolRequestResult;

  /** 解析同步响应 */
  protected abstract parseResponse(
    protocol: ProtocolService,
    data: unknown
  ): { urls: string[]; text?: string };

  async generate(
    ctx: CapabilityContext,
    params: CapabilityParams
  ): Promise<GenerationResult> {
    const protocol = getProtocol(ctx.protocol);
    if (!protocol) {
      throw new Error(`Protocol ${ctx.protocol} is not registered`);
    }

    // 管线构建请求体：transforms → auto-clean → mapping → patch
    const body = build({
      params,
      modelName: ctx.model,
      capability: this.capability,
      protocol: ctx.protocol,
      baseUrl: ctx.baseUrl,
      taskId: ctx.taskId,
    });

    // 从 model-ui.json 上游级解析 endpoints
    const endpoints = resolveProviderEndpoints(hostFromBaseUrl(ctx.baseUrl), ctx.model, this.capability);
    const endpointCfg: CapabilityEndpointConfig = endpoints ? { protocol: { endpoints } } : undefined;

    const req = this.buildRequest(protocol, ctx, params, body, endpointCfg);

    // 请求组装完成阶段：内部参数已按厂商协议生成具体请求，即将提交
    logEvent(`capability.${this.capability}`, {
      banner: true,
      bannerTitle: `${CAPABILITY_LABELS[this.capability] ?? this.capability}请求组装完成，即将提交`,
      stage: "translation_done",
      taskId: ctx.taskId,
      url: req.url,
      method: req.method,
      body: req.body,
    });

    const result = await submitAndWait({
      taskId: ctx.taskId,
      userId: ctx.userId,
      startedAt: ctx.startedAt,
      protocol,
      capability: this.capability,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      body,
      channelConfig: endpointCfg,
      buildRequest: () => req,
      parseResponse: (data) => this.parseResponse(protocol, data),
    });

    if (result.status === "cancelled") {
      throw new GenerationCancelledError();
    }

    if (result.status === "failed") {
      throw new GenerationFailureError(result.error ?? this.failFallback, result.errorCode);
    }

    return { urls: result.urls, text: result.text };
  }
}
