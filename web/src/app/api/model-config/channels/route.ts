import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { channelCreateSchema, maskApiKey } from "@server/schemas/model-config";
import { getChannels, createChannel } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const channels = await getChannels(auth.user.id);

  const result = channels.map((ch) => ({
    ...ch,
    apiKey: maskApiKey(ch.apiKey),
    models: ch.models,
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

  const parsed = channelCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const channel = await createChannel({
    userId: auth.user.id,
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
