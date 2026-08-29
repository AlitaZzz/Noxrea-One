/**
 * Gateway 路由。
 * 根据请求的能力、协议与渠道解析出对应的能力实现，
 * 并构建调用上游所需的路由上下文。
 */

import { getCapability } from "@server/services/capabilities/base";
import { GenerationFailureError } from "@server/core/errors/task-failure";
import type { GenerationResult } from "@server/schemas/result";

export interface RouteContext {
  capability: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: number;
  userId: number;
  taskId: string;
  config?: Record<string, unknown>;
  params: Record<string, unknown>;
}

/**
 * 统一路由分发。
 *
 * 同步/异步判定由 CapabilityService 内部的 TaskManager.submitAndWait 完成，
 * Executor 只需调用此路由一次即可（对齐 Python CapabilityRouter.dispatch）。
 */
export async function routeGenerate(ctx: RouteContext): Promise<GenerationResult> {
  const capService = getCapability(ctx.capability);
  if (!capService) {
    throw new GenerationFailureError(
      `Unknown capability: ${ctx.capability}`,
      "generation.unknown_capability"
    );
  }

  return capService.generate(
    {
      providerId: ctx.providerId,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      protocol: ctx.protocol,
      model: ctx.model,
      config: ctx.config,
      userId: ctx.userId,
      taskId: ctx.taskId,
    },
    ctx.params as Record<string, unknown> & { prompt: string }
  );
}
