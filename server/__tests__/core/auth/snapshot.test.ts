/**
 * 鉴权快照（specs/auth-request-verification.md 规则 1–4）：
 * 命中零查询、未命中原�源并 NX 回填、NX 竞争以键内值为准、Redis 故障回源、
 * 不做负缓存、写路径覆盖而非删除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  redis: null as unknown as {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  } | null,
}));

vi.mock("@server/core/database/client", () => ({
  prisma: { user: { findUnique: mocks.findUnique } },
}));
vi.mock("@server/core/redis/client", () => ({ getRequestPathRedis: () => mocks.redis }));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import {
  AUTH_SNAPSHOT_TTL_SECONDS,
  invalidateAuthSnapshot,
  readAuthSnapshot,
} from "@server/core/auth/snapshot";
import { metrics } from "@server/core/metrics";

const SNAPSHOT_KEY = "noxrea:auth:snap:7";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redis = { get: mocks.get, set: mocks.set, del: mocks.del };
  mocks.get.mockResolvedValue(null);
  mocks.set.mockResolvedValue("OK");
  mocks.findUnique.mockResolvedValue({ isActive: true, tokenVersion: 0 });
});

describe("readAuthSnapshot", () => {
  it("命中快照时不再查询数据库", async () => {
    mocks.get.mockResolvedValue(JSON.stringify({ tokenVersion: 3, isActive: true }));

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 3, isActive: true });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("未命中时回源数据库并以 NX + TTL 回填", async () => {
    mocks.findUnique.mockResolvedValue({ isActive: true, tokenVersion: 2 });

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 2, isActive: true });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(
      SNAPSHOT_KEY,
      JSON.stringify({ tokenVersion: 2, isActive: true }),
      "EX",
      AUTH_SNAPSHOT_TTL_SECONDS,
      "NX",
    );
  });

  it("NX 竞争失败时以键内值为准，不返回自己查到的旧值", async () => {
    // 读路径查到旧状态（tokenVersion 2），但写路径已把键覆盖为新状态
    mocks.findUnique.mockResolvedValue({ isActive: true, tokenVersion: 2 });
    mocks.set.mockResolvedValue(null);
    mocks.get.mockResolvedValueOnce(null).mockResolvedValue(
      JSON.stringify({ tokenVersion: 3, isActive: false }),
    );

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 3, isActive: false });
  });

  it("快照形态非法时按未命中处理并回源覆盖", async () => {
    mocks.get.mockResolvedValue("not-json");
    mocks.findUnique.mockResolvedValue({ isActive: true, tokenVersion: 5 });

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 5, isActive: true });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("键内是不可解析的脏值时不覆盖：读路径不做无 CAS 的盲写", async () => {
    // 覆盖脏值看似能省掉后续回源，但可能落在并发写路径刚提交的新值上，把吊销推迟一个 TTL
    mocks.get.mockResolvedValueOnce("not-json"); // 首次读取：脏值 → 未命中
    mocks.set.mockResolvedValueOnce(null); // NX 失败：键存在
    mocks.get.mockResolvedValueOnce("not-json"); // NX 后回读：仍是脏值
    mocks.findUnique.mockResolvedValue({ isActive: true, tokenVersion: 5 });

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 5, isActive: true });
    // 只有那一次 NX，没有任何覆盖写
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(
      SNAPSHOT_KEY,
      JSON.stringify({ tokenVersion: 5, isActive: true }),
      "EX",
      AUTH_SNAPSHOT_TTL_SECONDS,
      "NX",
    );

    // 脏值仍在键内：下一次请求照常回源（代价有界，脏值被写路径或 TTL 清掉后恢复命中）
    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 5, isActive: true });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("NX 与回读之间键消失（错过竞争 / TTL 到期）时不重建键，避免复活旧值", async () => {
    // 读路径查到旧状态 tokenVersion 2；与此同时写路径提交了新状态并删除快照
    mocks.findUnique.mockResolvedValue({ isActive: true, tokenVersion: 2 });
    mocks.set.mockResolvedValueOnce(null); // NX 失败：键当时存在
    mocks.get.mockResolvedValue(null); // 回读：键已被写路径删除 / 已到期

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 2, isActive: true });
    // 本次请求用查库结果（鉴权正确），但绝不写回：只保留那一次失败的 NX
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(
      SNAPSHOT_KEY,
      JSON.stringify({ tokenVersion: 2, isActive: true }),
      "EX",
      AUTH_SNAPSHOT_TTL_SECONDS,
      "NX",
    );
  });

  it("用户不存在时返回 null 且不写负缓存", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(readAuthSnapshot(7)).resolves.toBeNull();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("并发未命中只回源一次、只回填一次", async () => {
    const results = await Promise.all([
      readAuthSnapshot(7),
      readAuthSnapshot(7),
      readAuthSnapshot(7),
      readAuthSnapshot(7),
      readAuthSnapshot(7),
    ]);

    expect(results.every((r) => r?.tokenVersion === 0)).toBe(true);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledTimes(1);
  });

  it("Redis 未初始化时直接回源数据库", async () => {
    mocks.redis = null;

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 0, isActive: true });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("Redis 读失败时回源数据库，且不写入缓存", async () => {
    mocks.get.mockRejectedValue(new Error("redis down"));

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 0, isActive: true });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("回填失败时仍返回数据库结果（不影响鉴权）", async () => {
    mocks.set.mockRejectedValue(new Error("redis down"));
    mocks.findUnique.mockResolvedValue({ isActive: true, tokenVersion: 4 });

    await expect(readAuthSnapshot(7)).resolves.toEqual({ tokenVersion: 4, isActive: true });
  });
});

describe("invalidateAuthSnapshot", () => {
  /** 写路径结果的指标必须与读路径分开取值：共用 `error` 会让写失败在指标上不可见 */
  let snapshotMetric: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    snapshotMetric = vi.spyOn(metrics, "authSnapshot").mockImplementation(() => {});
  });
  afterEach(() => {
    snapshotMetric.mockRestore();
  });

  it("写入提交后的权威状态（覆盖而非删除）", async () => {
    await invalidateAuthSnapshot({ id: 7, isActive: false, tokenVersion: 4 });

    expect(mocks.set).toHaveBeenCalledWith(
      SNAPSHOT_KEY,
      JSON.stringify({ tokenVersion: 4, isActive: false }),
      "EX",
      AUTH_SNAPSHOT_TTL_SECONDS,
    );
    expect(mocks.del).not.toHaveBeenCalled();
    expect(snapshotMetric).toHaveBeenCalledWith("invalidated");
  });

  it("写入失败时退化为删除，让读路径回源", async () => {
    mocks.set.mockRejectedValue(new Error("redis down"));

    await invalidateAuthSnapshot({ id: 7, isActive: true, tokenVersion: 1 });

    expect(mocks.del).toHaveBeenCalledWith(SNAPSHOT_KEY);
    expect(snapshotMetric).toHaveBeenCalledWith("invalidated_fallback");
  });

  it("写入与删除都失败时不抛错（陈旧上界由 TTL 兜住），并记独立的写路径错误", async () => {
    mocks.set.mockRejectedValue(new Error("redis down"));
    mocks.del.mockRejectedValue(new Error("redis down"));

    await expect(
      invalidateAuthSnapshot({ id: 7, isActive: true, tokenVersion: 1 }),
    ).resolves.toBeUndefined();
    expect(snapshotMetric).toHaveBeenCalledWith("invalidate_error");
  });

  it("Redis 未初始化时静默跳过：不写缓存也不记指标", async () => {
    mocks.redis = null;

    await expect(
      invalidateAuthSnapshot({ id: 7, isActive: true, tokenVersion: 1 }),
    ).resolves.toBeUndefined();
    expect(mocks.set).not.toHaveBeenCalled();
    // 什么都没尝试；下一次读取自会记 db_fallback，这里补记会让回源比例虚高
    expect(snapshotMetric).not.toHaveBeenCalled();
  });
});
