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

/** 读取渠道协议配置中的 endpoint 表，过滤掉非字符串值。 */
export function getProtocolEndpoints(
  channelConfig?: Record<string, unknown>
): Record<string, string> | undefined {
  const protocol = channelConfig?.protocol;
  if (!protocol || typeof protocol !== "object") return undefined;
  const endpoints = (protocol as Record<string, unknown>).endpoints;
  if (!endpoints || typeof endpoints !== "object") return undefined;

  const entries = Object.entries(endpoints).filter(([, value]) => typeof value === "string");
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : undefined;
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

/** 协议能力声明：Agent 层按声明分支，不再硬编码协议名字符串比较 */
export interface ProtocolCapabilities {
  /** LLM 请求是否支持 tools（function calling）注入 */
  supportsTools?: boolean;
  /** LLM 消息是否支持多模态 image_url 内容段 */
  supportsImageParts?: boolean;
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

  /** 能力声明（缺省视为均不支持；Agent 侧按此降级） */
  readonly capabilities?: ProtocolCapabilities;

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

  /** 解析图片响应 */
  parseImageResponse?(response: unknown): ProtocolResponse;

  /** 解析视频响应 */
  parseVideoResponse?(response: unknown): ProtocolResponse;

  /** 解析 LLM 响应 */
  parseLlmResponse?(response: unknown): ProtocolResponse;

  // 异步任务支持

  /** 从响应中提取上游异步 task_id */
  extractTaskId?(data: unknown, channelConfig?: Record<string, unknown>, capability?: string): string | null;

  /** 构造轮询 URL */
  buildPollUrl?(baseUrl: string, upstreamTaskId: string, channelConfig?: Record<string, unknown>, capability?: string, model?: string): string;

  /** 解析轮询响应 */
  parsePollResponse?(data: unknown): PollResult;

  /**
   * 构建取消上游任务的请求（可选能力）。
   * 现状（2026-09 决策）：各上游暂时不支持取消任务，所有协议均不实现本能力，
   * 仅保留此骨架——取消退化为仅本地终态。后续接入某个上游的取消端点前，
   * 必须先核实其真实端点与语义，再在对应协议类补实现。
   * 取消调用是 best-effort：失败只记日志，绝不影响本地取消语义。
   */
  buildCancelRequest?(
    baseUrl: string,
    upstreamTaskId: string,
    apiKey: string,
    channelConfig?: Record<string, unknown>,
    capability?: string
  ): ProtocolRequestResult;
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

/** 无自定义轮询路径时的默认轮询 URL（`tasks/{id}` 惯例路径，manager 兜底与 openai shared 共用） */
export function defaultPollUrl(baseUrl: string, upstreamTaskId: string): string {
  return `${baseUrl}/tasks/${upstreamTaskId}`;
}
