/**
 * 请求的限流身份 IP。
 * X-Forwarded-For 可伪造：默认取直连 socket peer，只有 peer 命中可信代理网段时才解析该头。
 * 登录 / 注册共用同一入口，避免安全敏感的解析规则在各路由重复实现后漂移。
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

import { resolveRateLimitIp } from "@server/core/ratelimit/client-ip";
import { getSetting } from "@server/core/settings";

export function requestRateLimitIp(c: Context): string {
  return resolveRateLimitIp({
    remoteAddress: getConnInfo(c).remote.address,
    forwardedFor: c.req.raw.headers.get("x-forwarded-for"),
    trustedProxyCidrs: getSetting("network.trusted_proxy_cidrs"),
  });
}
