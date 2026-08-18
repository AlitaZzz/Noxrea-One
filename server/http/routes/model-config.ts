/**
 * 模型供应商配置路由。
 * 处理供应商、模型与能力配置的查询、创建、更新与删除等接口。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { providerCreateSchema, providerUpdateSchema, maskApiKey } from "@server/schemas/model-config";
import { modelInfoCreateSchema, batchSetModelsSchema, updateCapabilitySchema } from "@server/schemas/provider-config";
import {
  getProviders, createProvider, getProvider, updateProvider, deleteProvider,
  addModel, batchSetModels, deleteModel, updateModelCapability,
} from "@server/crud/model-config";
import { loadPresets } from "@server/services/model-config";
import { ok, fail } from "@server/core/response";

const router = new Hono();

// GET /api/model-config/providers
router.get("/api/model-config/providers", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const providers = await getProviders(auth.user.id);
  const result = providers.map((p) => ({
    ...p,
    apiKey: maskApiKey(p.apiKey),
    models: p.models,
  }));

  return c.json(ok(result));
});

// POST /api/model-config/providers
router.post("/api/model-config/providers", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = providerCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const provider = await createProvider({
    userId: auth.user.id,
    name: parsed.data.name,
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    protocol: parsed.data.protocol,
  });

  return c.json(
    ok({
      ...provider,
      apiKey: maskApiKey(provider.apiKey),
      models: provider.models,
    })
  );
});

// GET /api/model-config/providers/:id
router.get("/api/model-config/providers/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const rawId = c.req.param("id");
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid provider ID");

  const provider = await getProvider(id, auth.user.id);
  if (!provider) return fail(404, "Provider not found");

  return c.json(
    ok({
      ...provider,
      apiKey: maskApiKey(provider.apiKey),
      models: provider.models,
    })
  );
});

// GET /api/model-config/providers/:id/apikey — 按需返回明文 apiKey（不掩码）
router.get("/api/model-config/providers/:id/apikey", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const rawId = c.req.param("id");
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid provider ID");

  const provider = await getProvider(id, auth.user.id);
  if (!provider) return fail(404, "Provider not found");

  return c.json(ok({ apiKey: provider.apiKey }));
});

// PUT /api/model-config/providers/:id
router.put("/api/model-config/providers/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const rawId = c.req.param("id");
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid provider ID");

  const existing = await getProvider(id, auth.user.id);
  if (!existing) return fail(404, "Provider not found");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = providerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const provider = await updateProvider(id, auth.user.id, {
    name: parsed.data.name,
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    protocol: parsed.data.protocol,
  });
  if (!provider) return fail(404, "Provider not found");

  return c.json(
    ok({
      ...provider,
      apiKey: maskApiKey(provider.apiKey),
      models: provider.models,
    })
  );
});

// DELETE /api/model-config/providers/:id
router.delete("/api/model-config/providers/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const rawId = c.req.param("id");
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid provider ID");

  const result = await deleteProvider(id, auth.user.id);
  if (result.count === 0) return fail(404, "Provider not found");
  return c.json(ok(null, "Provider deleted"));
});

// GET /api/model-config/presets
router.get("/api/model-config/presets", (c) => {
  const presets = loadPresets();
  return c.json(ok(presets));
});

// POST /api/model-config/providers/:id/models
router.post("/api/model-config/providers/:id/models", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const providerId = parseInt(c.req.param("id"), 10);
  if (isNaN(providerId)) return fail(400, "Invalid provider ID");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = modelInfoCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const model = await addModel(providerId, auth.user.id, {
    name: parsed.data.name,
    capabilities: parsed.data.capabilities,
  });
  if (!model) return fail(404, "Provider not found");

  return c.json(ok(model));
});

// POST /api/model-config/providers/:id/models/set
router.post("/api/model-config/providers/:id/models/set", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const providerId = parseInt(c.req.param("id"), 10);
  if (isNaN(providerId)) return fail(400, "Invalid provider ID");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = batchSetModelsSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, `Schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }

  const models = await batchSetModels(providerId, auth.user.id, parsed.data.models);
  if (!models) return fail(404, "Provider not found");
  return c.json(ok(models));
});

// DELETE /api/model-config/providers/:id/models/:mid
router.delete("/api/model-config/providers/:id/models/:mid", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const modelId = parseInt(c.req.param("mid"), 10);
  if (isNaN(modelId)) return fail(400, "Invalid model ID");

  const result = await deleteModel(modelId, auth.user.id);
  if (result.count === 0) return fail(404, "Model not found");
  return c.json(ok(null, "Model deleted"));
});

// PUT /api/model-config/providers/:id/models/:mid/capability
router.put("/api/model-config/providers/:id/models/:mid/capability", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const modelId = parseInt(c.req.param("mid"), 10);
  if (isNaN(modelId)) return fail(400, "Invalid model ID");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = updateCapabilitySchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const model = await updateModelCapability(modelId, auth.user.id, parsed.data.capabilities);
  if (!model) return fail(404, "Model not found");
  return c.json(ok(model));
});

export { router };
