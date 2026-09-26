/**
 * 模型能力路由。
 * 提供模型列表查询与按能力过滤等接口，含跨域模型代理转发。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/http/middleware/auth";
import { resolveAndValidate } from "@server/core/ssrf";
import { fetchWithTimeout } from "@server/core/http-client";
import { getProvider } from "@server/crud/model-config";
import { logger } from "@server/core/logger";
import { ok, failCode } from "@server/core/response";
import type { ErrorCode } from "@server/core/errors/codes";

const router = new Hono();

/**
 * 将上游失败归一化为机器可读错误码。
 * 只回传错误码与插值参数，不把英文原始错误串下发前端。
 */
function classifyUpstreamFailure(params: {
  status?: number;
  host?: string;
}): { error: ErrorCode; ctx: Record<string, string | number> } {
  const { status, host } = params;
  const ctx: Record<string, string | number> = {};
  if (host) ctx.host = host;

  // 无 HTTP 状态码即请求未抵达上游（DNS 失败、连接被拒、超时、TLS 错误等）
  if (status === undefined) {
    return { error: "models.upstream_unreachable", ctx };
  }

  ctx.status = status;
  switch (status) {
    case 401:
      return { error: "models.upstream_unauthorized", ctx };
    case 403:
      return { error: "models.upstream_forbidden", ctx };
    case 404:
      return { error: "models.upstream_not_found", ctx };
    case 429:
      return { error: "models.upstream_rate_limited", ctx };
  }
  if (status >= 500) {
    return { error: "models.upstream_server_error", ctx };
  }
  return { error: "models.upstream_fetch_failed", ctx };
}

/** 去掉末尾斜杠 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 模型列表路径：直接请求 {baseUrl}/models，不自动补 /v1 */
function getModelListUrl(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}/models`;
}

// POST /api/models/list
router.post("/api/models/list", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const { providerId, baseUrl: rawBaseUrl, apiKey: rawApiKey } = body as {
    providerId?: number | string;
    baseUrl?: string;
    apiKey?: string;
  };

  let baseUrl: string;
  let apiKey: string | undefined;

  if (providerId) {
    const provider = await getProvider(Number(providerId), auth.user.id);
    if (!provider) return failCode(404, "models.provider_not_found");
    baseUrl = provider.baseUrl;
    apiKey = provider.apiKey || undefined;
  } else if (rawBaseUrl) {
    baseUrl = rawBaseUrl;
    apiKey = rawApiKey;
  } else {
    return failCode(400, "models.provider_id_or_base_url_required");
  }

  const modelListUrl = getModelListUrl(baseUrl);

  try {
    const hostname = new URL(modelListUrl).hostname;
    await resolveAndValidate(hostname);

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    let lastStatus: number | undefined;
    let lastUpstreamError: string | null = null;

    try {
      const response = await fetchWithTimeout(modelListUrl, {
        method: "GET",
        headers,
        scene: "api",
      });
      if (response.ok) {
        const raw: unknown = await response.json();
        const models = Array.isArray(raw)
          ? raw
          : typeof raw === "object" && raw !== null && "data" in raw && Array.isArray(raw.data)
            ? raw.data
            : [];
        return c.json(ok(models));
      }
      const errBody = await response.text().catch(() => "");
      lastStatus = response.status;
      // 截断上游响应体：仅用于日志，避免网关 HTML 错误页刷屏
      lastUpstreamError = `${response.status}: ${errBody.slice(0, 500)}`;
    } catch (err: unknown) {
      lastStatus = undefined;
      lastUpstreamError = err instanceof Error ? err.message : String(err);
    }

    // 上游原始错误只落服务端日志，不随响应下发
    logger.warn(
      { host: hostname, baseUrl: modelListUrl, status: lastStatus, upstreamError: lastUpstreamError },
      "Failed to fetch models from upstream"
    );

    const { error, ctx } = classifyUpstreamFailure({
      status: lastStatus,
      host: hostname,
    });
    return failCode(502, error, ctx);
  } catch (err: unknown) {
    logger.warn({ err, baseUrl: modelListUrl, providerId }, "Failed to fetch models");
    return failCode(500, "models.fetch_failed");
  }
});

export { router };
