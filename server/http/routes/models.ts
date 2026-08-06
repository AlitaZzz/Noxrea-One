/**
 * 模型能力路由。
 * 提供模型列表查询与按能力过滤等接口，含跨域模型代理转发。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { resolveAndValidate } from "@server/core/ssrf";
import { fetchWithTimeout } from "@server/core/http-client";
import { getChannel } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

const router = new Hono();

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
      return { baseUrl: url, paths: ["/models"] };
  }
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
    return fail(400, "Invalid JSON body");
  }

  const { channelId, baseUrl: rawBaseUrl, apiKey: rawApiKey } = body as {
    channelId?: number | string;
    baseUrl?: string;
    apiKey?: string;
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
    return fail(400, "channelId or baseUrl is required");
  }

  const { baseUrl: normalizedBase, paths } = getModelPaths(protocol, baseUrl);

  try {
    const hostname = new URL(normalizedBase).hostname;
    await resolveAndValidate(hostname);

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
          scene: "api",
        });
        if (response.ok) {
          const raw = await response.json();
          const models = !Array.isArray(raw) && raw && Array.isArray((raw as any).data)
            ? (raw as any).data
            : Array.isArray(raw)
              ? raw
              : [];
          return c.json(ok(models));
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
});

export { router };
