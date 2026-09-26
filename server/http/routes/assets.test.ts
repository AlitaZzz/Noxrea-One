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

import { router } from "./assets";

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
