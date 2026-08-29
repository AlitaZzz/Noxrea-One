/**
 * 统一响应格式。
 * 定义接口标准返回结构及成功、错误等构造辅助函数。
 *
 * 错误一律经 failCode 返回错误码，不再下发任何面向调试的文案；
 * 上游原始错误、堆栈等调试信息写入服务端日志并带上请求 ID。
 */
import { getRequestContext } from "@server/core/logger/context";
import type { ErrorCode } from "@server/core/errors/codes";

export interface UnifiedResponse<T = unknown> {
  code: number;
  data: T;
  msg: string;
}

/** 成功响应：UnifiedResponse 格式 */
export function ok<T>(data: T, msg = "success"): UnifiedResponse<T> {
  return { code: 200, data, msg };
}

/**
 * 结构化错误响应体。
 * error 为机器可读错误码（前端据其查 i18n），ctx 为文案插值参数。
 * 响应体只回传这两项：上游原始错误、堆栈等调试信息一律写入服务端日志，
 * 避免内部细节随响应下发到客户端。
 */
export interface ErrorPayload {
  error: string;
  ctx?: Record<string, string | number>;
  /** 请求 ID，对应服务端日志中的 req 字段，供用户报障时回传 */
  requestId?: string;
}

/**
 * 错误响应：结构化错误码 + HTTP 状态码。
 * 所有业务接口一律使用本函数，前端按 error 查 i18n 展示本地化文案。
 * error 限定为错误码字典（@server/core/errors/codes）中已登记的值，确保不会漏配文案。
 */
export function failCode(
  status: number,
  error: ErrorCode,
  ctx?: Record<string, string | number>
): Response {
  const payload: ErrorPayload = { error };
  if (ctx && Object.keys(ctx).length > 0) payload.ctx = ctx;
  // 请求 ID 由中间件注入异步上下文，此处自动带上，调用方无需感知
  const requestId = getRequestContext()?.requestId;
  if (requestId) payload.requestId = requestId;
  return Response.json(payload, { status });
}
