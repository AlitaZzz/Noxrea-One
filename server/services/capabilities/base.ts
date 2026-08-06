/**
 * 能力抽象基类。
 * 定义 Capability 的注册、上下文与统一调用接口，供各能力实现继承。
 */

import type { GenerationResult } from "@server/schemas/result";

export interface CapabilityContext {
  channelId: number;
  baseUrl: string;
  apiKey: string;
  protocol: string;
  model: string;
  config?: Record<string, unknown>;
  userId: number;
  taskId: string;
}

export interface CapabilityParams {
  prompt: string;
  [key: string]: unknown;
}

export interface CapabilityService {
  /** 能力名称 */
  readonly name: string;

  /** 生成（同步/异步由内部 TaskManager.submitAndWait 自动判定） */
  generate(
    ctx: CapabilityContext,
    params: CapabilityParams
  ): Promise<GenerationResult>;
}

/** 能力注册表 */
const capabilityRegistry = new Map<string, CapabilityService>();

export function registerCapability(
  name: string,
  service: CapabilityService
): void {
  capabilityRegistry.set(name, service);
}

export function getCapability(name: string): CapabilityService | undefined {
  return capabilityRegistry.get(name);
}
