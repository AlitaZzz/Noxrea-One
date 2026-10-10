import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getAssets: vi.fn(),
}));

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticate,
}));

vi.mock("@server/crud/asset", () => ({
  AssetOperationError: class extends Error {},
  getFolders: vi.fn(),
  createFolder: vi.fn(),
  getFolder: vi.fn(),
  updateFolder: vi.fn(),
  deleteFolder: vi.fn(),
  getAssets: mocks.getAssets,
  getAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
  deleteAssetsBatch: vi.fn(),
  deleteAssetsBySourceUrls: vi.fn(),
  createAssetsBatch: vi.fn(),
  updateAssetsBatch: vi.fn(),
  listSourceUrls: vi.fn(),
  getAssetLibrarySummary: vi.fn(),
}));

import { deleteAssetsBatch } from "@server/crud/asset";
import { router } from "@server/http/routes/assets";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ user: { id: 1 } });
  mocks.getAssets.mockResolvedValue({ items: [], total: 0, nextCursor: null });
});

describe("GET /api/assets/items limit 校验", () => {
  it("limit 非数字（NaN 穿透）返回 422，不再流入 Prisma take", async () => {
    const res = await router.request("/api/assets/items?limit=abc");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("common.invalid_request");
    expect(mocks.getAssets).not.toHaveBeenCalled();
  });

  it("limit 为 0 或负数返回 422", async () => {
    expect((await router.request("/api/assets/items?limit=0")).status).toBe(422);
    expect((await router.request("/api/assets/items?limit=-5")).status).toBe(422);
  });

  it("合法 limit 原样传递给 CRUD 层", async () => {
    const res = await router.request("/api/assets/items?limit=50");
    expect(res.status).toBe(200);
    expect(mocks.getAssets).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it("不传 limit 时 limit 字段为 undefined（CRUD 层取默认值）", async () => {
    await router.request("/api/assets/items");
    expect(mocks.getAssets).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }));
  });
});

describe("DELETE /api/assets/items/batch 批次上限", () => {
  /** 服务端 200 上限是兜底护栏：客户端按 ASSET_BATCH_LIMIT 分片，超量整批 422 */
  it("201 个 id 返回 422，不进入 CRUD 层", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await router.request("/api/assets/items/batch", {
      method: "DELETE",
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(422);
  });

  it("恰好 200 个 id 通过校验进入 CRUD 层", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const res = await router.request("/api/assets/items/batch", {
      method: "DELETE",
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(200);
    expect(deleteAssetsBatch).toHaveBeenCalledTimes(1);
    expect(deleteAssetsBatch).toHaveBeenCalledWith(1, ids);
  });
});
