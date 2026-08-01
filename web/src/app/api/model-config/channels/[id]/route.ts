import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { channelUpdateSchema, maskApiKey } from "@server/schemas/model-config";
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
      ...channel,
      apiKey: maskApiKey(channel.apiKey),
      models: channel.models,
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

  const parsed = channelUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const channel = await updateChannel(id, {
    name: parsed.data.name,
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    protocol: parsed.data.protocol,
    config: parsed.data.config,
  });

  return Response.json(
    ok({
      ...channel,
      apiKey: maskApiKey(channel.apiKey),
      models: channel.models,
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
