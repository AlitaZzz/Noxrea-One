/**
 * 协议抽象基类。
 * 定义协议请求构建与工具调用的统一接口，供各上游协议实现继承。
 */

export interface ProtocolRequestResult {
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: unknown;
}

/** LLM 工具调用（function calling） */
export interface ProtocolToolCall {
  id: string;
  name: string;
  /** 已解析的参数对象；解析失败时为空对象 */
  args: Record<string, unknown>;
  /** 对话气泡中展示的中文名（由后台工具注册表提供） */
  label?: string;
}

export interface ProtocolResponse {
  urls: string[];
  text?: string;
  raw?: unknown;
  /** LLM 请求执行的工具调用 */
  toolCalls?: ProtocolToolCall[];
}

/** 轮询结果 */
export interface PollResult {
  status: "completed" | "failed" | "pending";
  urls: string[];
  text?: string;
  error?: string;
}

export interface ProtocolService {
  /** 协议名称 */
  readonly name: string;

  /** 构建图片生成请求（body 已经过管线 transforms→mapping→patch） */
  buildImageRequest?(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    channelConfig?: Record<string, unknown>,
    hasRef?: boolean
  ): ProtocolRequestResult;

  /** 构建视频生成请求 */
  buildVideoRequest?(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    channelConfig?: Record<string, unknown>
  ): ProtocolRequestResult;

  /** 构建 LLM 请求 */
  buildLlmRequest?(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult;

  /** 构建音频生成请求 */
  buildAudioRequest?(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult;

  /** 解析图片响应 */
  parseImageResponse?(response: unknown): ProtocolResponse;

  /** 解析视频响应 */
  parseVideoResponse?(response: unknown): ProtocolResponse;

  /** 解析 LLM 响应 */
  parseLlmResponse?(response: unknown): ProtocolResponse;

  /** 解析音频响应 */
  parseAudioResponse?(response: unknown): ProtocolResponse;

  // 异步任务支持

  /** 从响应中提取上游异步 task_id */
  extractTaskId?(data: unknown, channelConfig?: Record<string, unknown>, capability?: string): string | null;

  /** 构造轮询 URL */
  buildPollUrl?(baseUrl: string, upstreamTaskId: string, channelConfig?: Record<string, unknown>, capability?: string, model?: string): string;

  /** 解析轮询响应 */
  parsePollResponse?(data: unknown): PollResult;
}

/** 协议注册表 */
const protocolRegistry = new Map<string, ProtocolService>();

export function registerProtocol(
  name: string,
  service: ProtocolService
): void {
  protocolRegistry.set(name, service);
}

export function getProtocol(name: string): ProtocolService | undefined {
  return protocolRegistry.get(name);
}
