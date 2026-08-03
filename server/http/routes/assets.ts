import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import {
  folderCreateSchema,
  folderUpdateSchema,
  assetCreateSchema,
  assetBatchCreateSchema,
  assetBatchUpdateSchema,
} from "@server/schemas/asset";
import {
  getFolders,
  createFolder,
  getFolder,
  updateFolder,
  deleteFolder,
  getAssets,
  createAsset,
  getAsset,
  updateAsset,
  deleteAsset,
  createAssetsBatch,
  updateAssetsBatch,
  listSourceUrls,
} from "@server/crud/asset";
import { ok, fail } from "@server/core/response";

const router = new Hono();

// ════════ Folders ════════

// ── GET /api/assets/folders ──
router.get("/api/assets/folders", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const spaceKey = c.req.query("space_key") ?? "personal";
  const folders = await getFolders(auth.user.id, spaceKey);
  return c.json(ok(folders));
});

// ── POST /api/assets/folders ──
router.post("/api/assets/folders", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = folderCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const folder = await createFolder(auth.user.id, {
    name: parsed.data.name,
    spaceKey: parsed.data.spaceKey,
    parentId: parsed.data.parentId,
  });

  return c.json(ok(folder));
});

// ── GET /api/assets/folders/:id ──
router.get("/api/assets/folders/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid folder ID");

  const folder = await getFolder(id);
  if (!folder) return fail(404, "Folder not found");

  return c.json(ok(folder));
});

// ── PUT /api/assets/folders/:id ──
router.put("/api/assets/folders/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid folder ID");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = folderUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const folder = await updateFolder(id, parsed.data.name);
  return c.json(ok(folder));
});

// ── DELETE /api/assets/folders/:id ──
router.delete("/api/assets/folders/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid folder ID");

  await deleteFolder(id);
  return c.json(ok(null, "Folder deleted"));
});

// ════════ Items ════════

// ── GET /api/assets/items ──
router.get("/api/assets/items", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const folderIdRaw = c.req.query("folder_id");
  const skipRaw = c.req.query("skip");
  const limitRaw = c.req.query("limit");

  const params = {
    userId: auth.user.id,
    folderId: folderIdRaw ? parseInt(folderIdRaw, 10) : undefined,
    type: c.req.query("type") ?? undefined,
    search: c.req.query("search") ?? undefined,
    spaceKey: c.req.query("space_key") ?? undefined,
    skip: skipRaw ? parseInt(skipRaw, 10) : undefined,
    limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
  };

  const result = await getAssets(params);
  return c.json(ok({ items: result.items, total: result.total }));
});

// ── GET /api/assets/items/source-urls ──
// 注意：必须注册在 /api/assets/items/:id 之前，否则会被 :id 参数路由拦截
router.get("/api/assets/items/source-urls", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const spaceKey = c.req.query("space_key") ?? "personal";
  const urls = await listSourceUrls(auth.user.id, spaceKey);
  return c.json(ok(urls));
});

// ── POST /api/assets/items ──
router.post("/api/assets/items", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = assetCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const item = await createAsset({
    userId: auth.user.id,
    name: parsed.data.name,
    type: parsed.data.type,
    mediaType: parsed.data.mediaType,
    width: parsed.data.width,
    height: parsed.data.height,
    description: parsed.data.description,
    tags: parsed.data.tags,
    extraData: parsed.data.extraData,
    folderId: parsed.data.folderId,
    spaceKey: parsed.data.spaceKey,
  });

  return c.json(ok(item));
});

// ── GET /api/assets/items/:id ──
router.get("/api/assets/items/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid asset ID");

  const item = await getAsset(id);
  if (!item) return fail(404, "Asset not found");

  return c.json(ok(item));
});

// ── PUT /api/assets/items/:id ──
router.put("/api/assets/items/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid asset ID");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const item = await updateAsset(id, body as Record<string, unknown>);
  return c.json(ok(item));
});

// ── DELETE /api/assets/items/:id ──
router.delete("/api/assets/items/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid asset ID");

  await deleteAsset(id);
  return c.json(ok(null, "Asset deleted"));
});

// ════════ Batch ════════

// ── POST /api/assets/items/batch ──
router.post("/api/assets/items/batch", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = assetBatchCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const items = parsed.data.map((item) => ({
    userId: auth.user.id,
    name: item.name,
    type: item.type,
    mediaType: item.mediaType,
    width: item.width,
    height: item.height,
    description: item.description,
    tags: item.tags,
    extraData: item.extraData,
    folderId: item.folderId,
    spaceKey: item.spaceKey,
  }));

  const created = await createAssetsBatch(items);
  return c.json(ok(created));
});

// ── PUT /api/assets/items/batch ──
router.put("/api/assets/items/batch", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = assetBatchUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const result = await updateAssetsBatch(parsed.data.ids, parsed.data.updates);
  return c.json(ok(result));
});

export { router };
