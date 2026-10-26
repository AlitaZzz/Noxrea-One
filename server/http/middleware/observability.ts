/**
 * 访问日志 + HTTP 指标（specs/observability-baseline.md 规则 3.1 / 4）。
 *
 * 挂载位置：`requestId` 之后、所有路由之前——`next()` 之后才能读到最终状态码，
 * 也能读到 Hono 匹配到的路由模板。只记方法与路由模板：查询串（含签名参数、文件名）
 * 与请求头（含 cookie）一律不记（规则 4.2）。
 *
 * `/metrics` 本身既不进指标也不进访问日志（规则 2.4）：抓取流量不应污染请求统计。
 */
import type { MiddlewareHandler } from "hono";

import { logEvent } from "@server/core/logger/utils";
import { metrics, UNMATCHED_ROUTE_LABEL } from "@server/core/metrics";

const EXCLUDED_PATH = "/metrics";

/**
 * 路由模板：未匹配（404 / 未注册路径）统一记为 other，原始路径不得成为标签（规则 3.2）。
 * Hono 对未匹配请求把 routePath 标成 `/*`，与空串同等处理。
 */
function routeLabel(routePath: string): string {
  return routePath === "" || routePath === "*" || routePath === "/*"
    ? UNMATCHED_ROUTE_LABEL
    : routePath;
}

export function observability(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === EXCLUDED_PATH) {
      await next();
      return;
    }
    const startedAt = performance.now();
    await next();
    const durationMs = performance.now() - startedAt;
    const status = c.res.status;
    const route = routeLabel(c.req.routePath);

    metrics.httpRequest(c.req.method, route, status, durationMs / 1000);
    logEvent("http", {
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      method: c.req.method,
      route,
      status,
      durationMs: Math.round(durationMs),
    });
  };
}
