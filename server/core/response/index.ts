/**
 * 统一响应格式。
 * 定义接口标准返回结构及成功、错误等构造辅助函数。
 */

export interface UnifiedResponse<T = unknown> {
  code: number;
  data: T;
  msg: string;
}

/** 成功响应：UnifiedResponse 格式 */
export function ok<T>(data: T, msg = "success"): UnifiedResponse<T> {
  return { code: 200, data, msg };
}

/** 错误响应：FastAPI 风格 { detail } + HTTP 状态码 */
export function fail(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}
