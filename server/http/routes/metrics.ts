/**
 * 指标端点（specs/observability-baseline.md 规则 2）。
 *
 * Prometheus 拉模型，无需 collector 先就位。三重约束：
 * - 默认关闭：`METRICS_ENABLED` 未开启时 404，连端点的存在性都不暴露；
 * - 开启即要求 `Authorization: Bearer <METRICS_TOKEN>`，常量时间比较；
 *   「开了指标但没配 token」在配置加载期就启动失败（见 core/config）；
 * - 不参与限流、不进 `http_requests_total` / 访问日志（抓取本身不应污染统计）。
 */
import { timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import { getConfig } from "@server/core/config";
import { metrics } from "@server/core/metrics";

const router = new Hono();

/** Bearer 校验：长度不同直接拒绝，长度相同走 timingSafeEqual（避免逐字节计时侧信道） */
function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return provided.length === target.length && timingSafeEqual(provided, target);
}

router.get("/metrics", async (c) => {
  const config = getConfig();
  if (!config.METRICS_ENABLED) return c.notFound();

  if (!bearerMatches(c.req.header("Authorization"), config.METRICS_TOKEN)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" },
    });
  }

  return new Response(await metrics.registry.metrics(), {
    headers: {
      "Content-Type": metrics.registry.contentType,
      "Cache-Control": "no-store",
    },
  });
});

export { router };
