import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { channelCreateSchema, channelUpdateSchema, maskApiKey } from "@server/schemas/model-config";
import { getChannels, createChannel, getChannel, updateChannel, deleteChannel } from "@server/crud/model-config";
import { loadPresets } from "@server/services/model-config";
import { ok, fail } from "@server/core/response";

const router = new Hono();

// ── GET /api/model-config/channels ──
router.get("/api/model-config/channels", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const channels = await getChannels(auth.user.id);
  const result = channels.map((ch) => ({
    ...ch,
    apiKey: maskApiKey(ch.apiKey),
    models: ch.models,
  }));

  return c.json(ok(result));
});

// ── POST /api/model-config/channels ──
router.post("/api/model-config/channels", async (c) => {
  const request = c.req.raw;
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

  return c.json(
    ok({
      ...channel,
      apiKey: maskApiKey(channel.apiKey),
      models: channel.models,
    })
  );
});

// ── GET /api/model-config/channels/:id ──
router.get("/api/model-config/channels/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const rawId = c.req.param("id");
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid channel ID");

  const channel = await getChannel(id);
  if (!channel) return fail(404, "Channel not found");

  return c.json(
    ok({
      ...channel,
      apiKey: maskApiKey(channel.apiKey),
      models: channel.models,
    })
  );
});

// ── PUT /api/model-config/channels/:id ──
router.put("/api/model-config/channels/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const rawId = c.req.param("id");
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

  return c.json(
    ok({
      ...channel,
      apiKey: maskApiKey(channel.apiKey),
      models: channel.models,
    })
  );
});

// ── DELETE /api/model-config/channels/:id ──
router.delete("/api/model-config/channels/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const rawId = c.req.param("id");
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid channel ID");

  await deleteChannel(id);
  return c.json(ok(null, "Channel deleted"));
});

// ── GET /api/model-config/presets ──
router.get("/api/model-config/presets", (c) => {
  const presets = loadPresets();
  return c.json(ok(presets));
});

export { router };
