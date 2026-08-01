// ── Protocol 抽象基类（对应 backend/app/services/protocols/base.py） ──

export interface ProtocolRequestResult {
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: unknown;
}

export interface ProtocolResponse {
  urls: string[];
  text?: string;
  raw?: unknown;
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
    channelConfig?: Record<string, unknown>
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

  // ── 异步任务支持 ──

  /** 从响应中提取上游异步 task_id（对应 Python extract_task_id） */
  extractTaskId?(data: unknown): string | null;

  /** 构造轮询 URL（对应 Python build_poll_url） */
  buildPollUrl?(baseUrl: string, upstreamTaskId: string, channelConfig?: Record<string, unknown>): string;

  /** 解析轮询响应（对应 Python parse_poll_response） */
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
