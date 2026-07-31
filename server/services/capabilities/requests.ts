// ── 统一请求对象（对应 backend/app/services/capabilities/requests.py） ──

export interface ImageGenRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  quality?: string;
  response_format?: string;
  [key: string]: unknown;
}

export interface VideoGenRequest {
  prompt: string;
  model?: string;
  [key: string]: unknown;
}

export interface LlmRequest {
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface AudioGenRequest {
  prompt: string;
  model?: string;
  voice?: string;
  [key: string]: unknown;
}

export interface BgRemovalRequest {
  image_url: string;
  [key: string]: unknown;
}
