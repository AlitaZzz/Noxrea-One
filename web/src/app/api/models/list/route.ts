import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { resolveAndValidate } from "@server/core/ssrf";
import { fetchWithTimeout } from "@server/core/http";
import { getConfig } from "@server/core/config";
import { getChannel } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

/** 去掉末尾斜杠 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * 根据协议获取模型列表路径。
 * 各协议按各自约定路径请求，不再自动补 /v1。
 */
function getModelPaths(protocol: string, baseUrl: string): { baseUrl: string; paths: string[] } {
  const proto = protocol?.toLowerCase() ?? "openai";
  const url = stripTrailingSlash(baseUrl);

  switch (proto) {
    case "openai":
      return { baseUrl: url, paths: ["/models"] };
    case "gemini":
      return { baseUrl: url, paths: ["/v1beta/models"] };
    default:
      // ark 及其他协议：保持 baseUrl 原样，直接请求 /models
      return { baseUrl: url, paths: ["/models"] };
  }
}

/**
 * 拉取上游模型列表（SSRF 校验 + DNS pinning）
 * 对应 backend/app/routers/models.py
 * 前端传 channelId，后端查库获取 base_url + api_key
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const { channelId, base_url: rawBaseUrl, api_key: rawApiKey } = body as {
    channelId?: number | string;
    base_url?: string;
    api_key?: string;
  };

  let baseUrl: string;
  let apiKey: string | undefined;
  let protocol = "openai";

  if (channelId) {
    const channel = await getChannel(Number(channelId));
    if (!channel) return fail(404, "Channel not found");
    baseUrl = channel.baseUrl;
    apiKey = channel.apiKey || undefined;
    protocol = channel.protocol;
  } else if (rawBaseUrl) {
    baseUrl = rawBaseUrl;
    apiKey = rawApiKey;
  } else {
    return fail(400, "channelId or base_url is required");
  }

  // 根据协议确定 baseUrl 和请求路径
  const { baseUrl: normalizedBase, paths } = getModelPaths(protocol, baseUrl);

  try {
    // SSRF 校验
    const hostname = new URL(normalizedBase).hostname;
    await resolveAndValidate(hostname);

    const cfg = getConfig();
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const tried: string[] = [];
    let lastError: string | null = null;

    for (const p of paths) {
      const fullUrl = normalizedBase + p;
      tried.push(fullUrl);
      try {
        const response = await fetchWithTimeout(fullUrl, {
          method: "GET",
          headers,
          timeoutMs: cfg.HTTP_API_READ * 1000,
        });
        if (response.ok) {
          const raw = await response.json();
          // 上游返回 OpenAI 格式 { object: "list", data: [...] }，提取 data 数组
          const models = Array.isArray(raw.data) ? raw.data : (Array.isArray(raw) ? raw : []);
          return Response.json(ok(models));
        }
        const errBody = await response.text().catch(() => "");
        lastError = `${response.status}: ${errBody}`;
      } catch (err: any) {
        lastError = err.message ?? "Request failed";
      }
    }

    return fail(502, `Failed to fetch models from upstream. Tried: ${tried.join(", ")}. Last error: ${lastError}`);
  } catch (err: any) {
    return fail(500, `Failed to fetch models: ${err.message ?? "Unknown error"}`);
  }
}
