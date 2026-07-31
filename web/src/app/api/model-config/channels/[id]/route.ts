import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { channelUpdateSchema, toChannelOut } from "@server/schemas/model-config";
import { toModelInfoOut } from "@server/schemas/channel-config";
import { getChannel, updateChannel, deleteChannel } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid channel ID");

  const channel = await getChannel(id);
  if (!channel) return fail(404, "Channel not found");

  return Response.json(
    ok({
      ...toChannelOut(channel),
      models: channel.models.map(toModelInfoOut),
    })
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid channel ID");

  const existing = await getChannel(id);
  if (!existing) return fail(404, "Channel not found");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  // 前端传 camelCase（baseUrl/apiKey），映射到后端期望的 snake_case
  const raw = body as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  if (raw.name !== undefined) mapped.name = raw.name;
  if (raw.baseUrl !== undefined) mapped.base_url = raw.baseUrl;
  else if (raw.base_url !== undefined) mapped.base_url = raw.base_url;
  if (raw.apiKey !== undefined) mapped.api_key = raw.apiKey;
  else if (raw.api_key !== undefined) mapped.api_key = raw.api_key;
  if (raw.protocol !== undefined) mapped.protocol = raw.protocol;
  if (raw.config !== undefined) mapped.config = raw.config;

  const parsed = channelUpdateSchema.safeParse(mapped);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const channel = await updateChannel(id, {
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid channel ID");

  await deleteChannel(id);
  return Response.json(ok(null, "Channel deleted"));
}
