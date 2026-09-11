/**
 * 资产与文件夹路由。
 * 处理资产、文件夹的查询、创建、更新与批量操作，所有写操作返回最新计数快照。
 */
import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { authenticateRequest } from "@server/core/auth/middleware";
import {
  folderCreateSchema,
  folderUpdateSchema,
  assetCreateSchema,
  assetUpdateSchema,
  assetBatchCreateSchema,
  assetBatchUpdateSchema,
} from "@server/schemas/asset";
import {
  AssetOperationError,
  getFolders,
  createFolder,
  getFolder,
  updateFolder,
  deleteFolder,
  getAssets,
  getAsset,
  updateAsset,
  deleteAsset,
  createAssetsBatch,
  updateAssetsBatch,
  listSourceUrls,
  getAssetLibrarySummary,
} from "@server/crud/asset";
import { ok, failCode } from "@server/core/response";
import {
  addAssetRef,
  removeAssetRef,
} from "@server/services/storage/ref-manager";
import { extractHashFromUrl } from "@server/utils/extract-hashes";

const router = new Hono();

/** 将 CRUD 层业务错误统一转换为 HTTP 错误码，避免事务细节泄漏到路由层。 */
function handleAssetError(error: unknown): Response | null {
  if (isSourceUrlUniqueError(error)) {
    return failCode(409, "assets.duplicate_source_url");
  }
  if (!(error instanceof AssetOperationError)) return null;
  if (error.code === "duplicate_source_url") {
    return failCode(409, "assets.duplicate_source_url");
  }
  if (error.code === "uncategorized_folder_protected") {
    return failCode(403, "assets.uncategorized_folder_protected");
  }
  if (error.code === "folder_not_found") {
    return failCode(404, "assets.folder_not_found");
  }
  return failCode(404, "assets.asset_not_found");
}

/** 判断唯一约束冲突是否来自资产来源 URL；避免把目录唯一冲突误报为来源重复。 */
function isSourceUrlUniqueError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const targetText = Array.isArray(target) ? target.join(":") : String(target ?? "");
  return targetText.includes("source_url");
}

// ════════ Folders ════════

router.get("/api/assets/folders", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const scope = c.req.query("scope") ?? "personal";
  const folders = await getFolders(auth.user.id, scope);
  return c.json(ok(folders));
});

router.get("/api/assets/bootstrap", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const scope = c.req.query("scope") ?? "personal";
  const summary = await getAssetLibrarySummary(auth.user.id, scope);
  return c.json(ok(summary));
});

router.post("/api/assets/folders", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = folderCreateSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const folder = await createFolder(auth.user.id, parsed.data);
    return c.json(ok(folder));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

router.get("/api/assets/folders/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return failCode(400, "assets.invalid_folder_id");

  const folder = await getFolder(auth.user.id, id);
  if (!folder) return failCode(404, "assets.folder_not_found");
  return c.json(ok(folder));
});

router.put("/api/assets/folders/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return failCode(400, "assets.invalid_folder_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = folderUpdateSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const folder = await updateFolder(auth.user.id, id, parsed.data.name);
    return c.json(ok(folder));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

router.delete("/api/assets/folders/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return failCode(400, "assets.invalid_folder_id");

  try {
    const result = await deleteFolder(auth.user.id, id);
    await Promise.all(
      result.sourceUrls.map((sourceUrl) => {
        const hash = extractHashFromUrl(sourceUrl);
        return hash ? removeAssetRef(hash, auth.user.id) : Promise.resolve();
      }),
    );
    return c.json(ok(result));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

// ════════ Items ════════

router.get("/api/assets/items", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const folderIdRaw = c.req.query("folder_id");
  const skipRaw = c.req.query("skip");
  const limitRaw = c.req.query("limit");
  const folderId = folderIdRaw ? parseInt(folderIdRaw, 10) : undefined;
  if (folderId !== undefined && isNaN(folderId)) return failCode(400, "assets.invalid_folder_id");

  const result = await getAssets({
    userId: auth.user.id,
    folderId,
    type: c.req.query("type") ?? undefined,
    search: c.req.query("search") ?? undefined,
    scope: c.req.query("scope") ?? undefined,
    skip: skipRaw ? parseInt(skipRaw, 10) : undefined,
    limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
  });

  return c.json(ok({ items: result.items, total: result.total }));
});

router.get("/api/assets/items/source-urls", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const scope = c.req.query("scope") ?? "personal";
  const urls = await listSourceUrls(auth.user.id, scope);
  return c.json(ok(urls));
});

router.post("/api/assets/items", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = assetCreateSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const result = await createAssetsBatch([{ ...parsed.data, userId: auth.user.id }]);
    const hash = result.items[0].sourceUrl ? extractHashFromUrl(result.items[0].sourceUrl) : null;
    if (hash) await addAssetRef(hash, auth.user.id);
    return c.json(ok({ item: result.items[0], counters: result.counters }));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

router.get("/api/assets/items/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return failCode(400, "assets.invalid_asset_id");

  const item = await getAsset(auth.user.id, id);
  if (!item) return failCode(404, "assets.asset_not_found");
  return c.json(ok(item));
});

router.put("/api/assets/items/batch", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = assetBatchUpdateSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const result = await updateAssetsBatch(auth.user.id, parsed.data.ids, parsed.data.updates);
    return c.json(ok(result));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

router.put("/api/assets/items/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return failCode(400, "assets.invalid_asset_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = assetUpdateSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const result = await updateAsset(auth.user.id, id, parsed.data);
    return c.json(ok(result));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

router.delete("/api/assets/items/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return failCode(400, "assets.invalid_asset_id");

  try {
    const result = await deleteAsset(auth.user.id, id);
    const hash = result.item.sourceUrl ? extractHashFromUrl(result.item.sourceUrl) : null;
    if (hash) await removeAssetRef(hash, auth.user.id);
    return c.json(ok({ counters: result.counters }));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

router.post("/api/assets/items/batch", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = assetBatchCreateSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const result = await createAssetsBatch(
      parsed.data.map((item) => ({ ...item, userId: auth.user.id }))
    );

    await Promise.all(
      result.items.map((item) => {
        const hash = item.sourceUrl ? extractHashFromUrl(item.sourceUrl) : null;
        return hash ? addAssetRef(hash, auth.user.id) : Promise.resolve();
      })
    );
    return c.json(ok({ items: result.items, counters: result.counters }));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

export { router };
