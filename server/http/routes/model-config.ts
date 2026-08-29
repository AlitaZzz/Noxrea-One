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
import { ok, failCode } from "@server/core/response";

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
    return failCode(400, "common.invalid_json");
  }

  const parsed = providerCreateSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
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
  if (isNaN(id)) return failCode(400, "model_config.invalid_provider_id");

  const provider = await getProvider(id, auth.user.id);
  if (!provider) return failCode(404, "model_config.provider_not_found");

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
  if (isNaN(id)) return failCode(400, "model_config.invalid_provider_id");

  const provider = await getProvider(id, auth.user.id);
  if (!provider) return failCode(404, "model_config.provider_not_found");

  return c.json(ok({ apiKey: provider.apiKey }));
});

// PUT /api/model-config/providers/:id
router.put("/api/model-config/providers/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const rawId = c.req.param("id");
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return failCode(400, "model_config.invalid_provider_id");

  const existing = await getProvider(id, auth.user.id);
  if (!existing) return failCode(404, "model_config.provider_not_found");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = providerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const provider = await updateProvider(id, auth.user.id, {
    name: parsed.data.name,
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    protocol: parsed.data.protocol,
  });
  if (!provider) return failCode(404, "model_config.provider_not_found");

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
  if (isNaN(id)) return failCode(400, "model_config.invalid_provider_id");

  const result = await deleteProvider(id, auth.user.id);
  if (result.count === 0) return failCode(404, "model_config.provider_not_found");
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
  if (isNaN(providerId)) return failCode(400, "model_config.invalid_provider_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = modelInfoCreateSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const model = await addModel(providerId, auth.user.id, {
    name: parsed.data.name,
    capabilities: parsed.data.capabilities,
  });
  if (!model) return failCode(404, "model_config.provider_not_found");

  return c.json(ok(model));
});

// POST /api/model-config/providers/:id/models/set
router.post("/api/model-config/providers/:id/models/set", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const providerId = parseInt(c.req.param("id"), 10);
  if (isNaN(providerId)) return failCode(400, "model_config.invalid_provider_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = batchSetModelsSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const models = await batchSetModels(providerId, auth.user.id, parsed.data.models);
  if (!models) return failCode(404, "model_config.provider_not_found");
  return c.json(ok(models));
});

// DELETE /api/model-config/providers/:id/models/:mid
router.delete("/api/model-config/providers/:id/models/:mid", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const modelId = parseInt(c.req.param("mid"), 10);
  if (isNaN(modelId)) return failCode(400, "model_config.invalid_model_id");

  const result = await deleteModel(modelId, auth.user.id);
  if (result.count === 0) return failCode(404, "model_config.model_not_found");
  return c.json(ok(null, "Model deleted"));
});

// PUT /api/model-config/providers/:id/models/:mid/capability
router.put("/api/model-config/providers/:id/models/:mid/capability", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const modelId = parseInt(c.req.param("mid"), 10);
  if (isNaN(modelId)) return failCode(400, "model_config.invalid_model_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = updateCapabilitySchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const model = await updateModelCapability(modelId, auth.user.id, parsed.data.capabilities);
  if (!model) return failCode(404, "model_config.model_not_found");
  return c.json(ok(model));
});

export { router };
