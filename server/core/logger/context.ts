/**
 * 请求上下文。
 * 基于 AsyncLocalStorage 在异步调用链中透传请求级信息（如 requestId），
 * 使日志与错误响应无需逐层传参即可自动携带同一个标识。
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** 请求级上下文数据 */
export interface RequestContext {
  /** 请求唯一标识，用于串联服务端日志与客户端报错 */
  requestId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * 在请求上下文中执行回调，回调内部的异步链路均可读取该上下文。
 * @param ctx 请求级上下文数据
 * @param fn 要执行的回调
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * 读取当前异步链路上的请求上下文。
 * 不在请求链路内（如后台定时任务）时返回 undefined。
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
