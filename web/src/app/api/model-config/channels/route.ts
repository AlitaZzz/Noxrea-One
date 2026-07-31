import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { channelCreateSchema, toChannelOut } from "@server/schemas/model-config";
import { toModelInfoOut } from "@server/schemas/channel-config";
import { getChannels, createChannel } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const channels = await getChannels(auth.user.id);

  const result = channels.map((ch) => ({
    ...toChannelOut(ch),
    models: ch.models.map(toModelInfoOut),
  }));

  return Response.json(ok(result));
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  // 前端传 camelCase（baseUrl/apiKey），映射到后端期望的 snake_case
  const raw = body as Record<string, unknown>;
  const mapped = {
    name: raw.name,
    base_url: raw.baseUrl ?? raw.base_url,
    api_key: raw.apiKey ?? raw.api_key,
    protocol: raw.protocol,
    config: raw.config,
  };

  const parsed = channelCreateSchema.safeParse(mapped);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const channel = await createChannel({
    userId: auth.user.id,
    name: parsed.data.name,
    baseUrl: parsed.data.base_url,
    apiKey: parsed.data.api_key,
    protocol: parsed.data.protocol,
    config: parsed.data.config,
  });

  return Response.json(
    ok({
      ...toChannelOut(channel),
      models: channel.models.map(toModelInfoOut),
    })
  );
}
