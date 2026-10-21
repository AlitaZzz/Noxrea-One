/**
 * 资产与文件夹路由。
 * 处理资产、文件夹的查询、创建、更新与批量操作，所有写操作返回最新计数快照。
 */
import { Hono } from "hono";
import { z } from "zod";
import { ASSET_ITEMS_USER_SCOPE_FILE_KEY } from "@server/core/database/constraint-names";
import { isUniqueConstraintViolation } from "@server/core/database/errors";
import { authenticateRequest } from "@server/http/middleware/auth";
import {
  ASSET_BATCH_LIMIT,
  folderCreateSchema,
  folderUpdateSchema,
  assetCreateSchema,
  assetUpdateSchema,
  assetBatchCreateSchema,
  assetBatchUpdateSchema,
  assetBatchDeleteSchema,
  assetDeleteByFileKeysSchema,
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
  deleteAssetsBatch,
  deleteAssetsByFileKeys,
  createAssetsBatch,
  updateAssetsBatch,
  listFileKeys,
  getAssetLibrarySummary,
} from "@server/crud/asset";
import { ok, failCode } from "@server/core/response";

const router = new Hono();

/** 将 CRUD 层业务错误统一转换为 HTTP 错误码，避免事务细节泄漏到路由层。 */
function handleAssetError(error: unknown): Response | null {
  if (isFileKeyUniqueError(error)) {
    return failCode(409, "assets.duplicate_file_key");
  }
  if (!(error instanceof AssetOperationError)) return null;
  if (error.code === "duplicate_file_key") {
    return failCode(409, "assets.duplicate_file_key");
  }
  if (error.code === "invalid_file_key") {
    return failCode(400, "assets.invalid_file_key");
  }
  if (error.code === "uncategorized_folder_protected") {
    return failCode(403, "assets.uncategorized_folder_protected");
  }
  if (error.code === "folder_not_found") {
    return failCode(404, "assets.folder_not_found");
  }
  return failCode(404, "assets.asset_not_found");
}

/** 判断唯一约束冲突是否来自资产来源引用；避免把目录唯一冲突误报为来源重复。 */
function isFileKeyUniqueError(error: unknown): boolean {
  return isUniqueConstraintViolation(error, ASSET_ITEMS_USER_SCOPE_FILE_KEY);
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
  const cursor = c.req.query("cursor") ?? undefined;
  const limitRaw = c.req.query("limit");
  const folderId = folderIdRaw ? parseInt(folderIdRaw, 10) : undefined;
  if (folderId !== undefined && isNaN(folderId)) return failCode(400, "assets.invalid_folder_id");

  // limit 经 zod 校验：NaN 会穿透 Math.min 钳制直达 Prisma take 变成 500，必须在入口拦成 422
  let limit: number | undefined;
  if (limitRaw) {
    const parsedLimit = z.coerce.number().int().positive().safeParse(limitRaw);
    if (!parsedLimit.success) return failCode(422, "common.invalid_request");
    limit = parsedLimit.data;
  }

  const result = await getAssets({
    userId: auth.user.id,
    folderId,
    type: c.req.query("type") ?? undefined,
    search: c.req.query("search") ?? undefined,
    scope: c.req.query("scope") ?? undefined,
    cursor,
    limit,
  });

  return c.json(ok({ items: result.items, total: result.total, nextCursor: result.nextCursor }));
});

router.get("/api/assets/items/file-keys", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const scope = c.req.query("scope") ?? "personal";
  const keys = await listFileKeys(auth.user.id, scope);
  return c.json(ok(keys));
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
    // 批量创建对重复来源是「跳过」，单条创建保持「重复即 409」语义，避免前端拿到空 item。
    if (!result.items[0]) return failCode(409, "assets.duplicate_file_key");
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

router.delete("/api/assets/items/batch", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = assetBatchDeleteSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const result = await deleteAssetsBatch(auth.user.id, parsed.data.ids);
    return c.json(ok(result));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

// DELETE /api/assets/items/by-file-keys — 画布「取消收藏」：按 fileKey 删除个人库条目（宽松语义）
router.delete("/api/assets/items/by-file-keys", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = assetDeleteByFileKeysSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const result = await deleteAssetsByFileKeys(auth.user.id, parsed.data.fileKeys);
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

  // 超出上限时给出可直接行动的提示，而不是笼统的「请求参数不合法」
  if (Array.isArray(body) && body.length > ASSET_BATCH_LIMIT) {
    return failCode(422, "assets.batch_too_large", { limit: ASSET_BATCH_LIMIT });
  }

  const parsed = assetBatchCreateSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");

  try {
    const result = await createAssetsBatch(
      parsed.data.map((item) => ({ ...item, userId: auth.user.id }))
    );

    // skipped 为因重复被跳过的来源，前端据此提示「已保存 N、跳过 M」。
    return c.json(ok({ items: result.items, counters: result.counters, skipped: result.skipped }));
  } catch (error) {
    return handleAssetError(error) ?? failCode(500, "common.internal_error");
  }
});

export { router };
