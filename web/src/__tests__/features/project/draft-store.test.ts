/**
 * 离线草稿存储测试。
 *
 * 恢复提示的判据是草稿代际（rev）与服务端 revision 的比较，
 * 不依赖客户端/服务端时钟（旧 updatedAt 比较有钟偏误报）。
 * 写入侧的核心不变量：草稿代际只前进不后退——更旧代际的写入被拒绝，
 * 防止迟到的固化用旧内容覆盖已固化的更新草稿。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  records: new Map<string, { projectId: string; rev?: number; canvasData: unknown }>(),
  chain: Promise.resolve(),
}));

vi.mock("idb", () => ({
  openDB: async () => ({
    get: async (_name: string, key: string) => mocks.records.get(key),
    put: async (_name: string, value: { projectId: string; rev?: number; canvasData: unknown }) => {
      mocks.records.set(value.projectId, value);
    },
    delete: async (_name: string, key: string) => {
      mocks.records.delete(key);
    },
    // 模拟 IndexedDB：同 store 的 readwrite 事务在创建时即占位、按创建顺序串行，
    // 事务内的读写必须等前序事务 done 后才开始执行——活跃事务的读改写间隙
    // 对其他事务不可见（真实 IndexedDB 由事务锁保证）
    transaction: () => {
      const entry = mocks.chain;
      let internal: Promise<void> = Promise.resolve();
      let release!: () => void;
      const completed = new Promise<void>((r) => { release = r; });
      mocks.chain = entry.then(() => completed);
      const step = <T>(op: () => T): Promise<T> => {
        const exec = internal.then(() => entry).then(() => op());
        internal = exec.then(() => undefined, () => undefined);
        return exec;
      };
      const store = {
        get: (key: string) =>
          step(() => {
            const value = mocks.records.get(key);
            return value ? { ...value } : undefined;
          }),
        put: (value: { projectId: string; rev?: number; canvasData: unknown }) =>
          step(() => {
            mocks.records.set(value.projectId, { ...value });
          }),
        delete: (key: string) =>
          step(() => {
            mocks.records.delete(key);
          }),
      };
      return {
        objectStore: () => store,
        get done() {
          release();
          return entry.then(() => internal, () => undefined);
        },
      };
    },
  }),
}));

import { clearStaleDraft, type DraftRecord, isDraftNewer, loadDraft, saveDraft } from "@/features/project/draft-store";

function draft(rev: number | undefined): DraftRecord | null {
  return rev === undefined
    ? null
    : {
        projectId: "p1",
        rev,
        canvasData: {
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          background: "dots",
          minimapVisible: true,
          snapToGrid: false,
        },
      };
}

beforeEach(() => {
  // draft-store 以 typeof window 判定运行环境，node 测试环境补一个空壳
  (globalThis as { window?: unknown }).window = {};
  mocks.records.clear();
});

describe("isDraftNewer", () => {
  it("草稿代际比服务端新时提示恢复", () => {
    expect(isDraftNewer(draft(3), 2)).toBe(true);
  });

  it("代际相等或更旧（含保存成功后的幽灵记录）不提示", () => {
    expect(isDraftNewer(draft(2), 2)).toBe(false);
    expect(isDraftNewer(draft(1), 2)).toBe(false);
  });

  it("无草稿不提示", () => {
    expect(isDraftNewer(null, 0)).toBe(false);
  });

  it("旧格式记录（无 rev 字段）按陈旧处理，永不提示", () => {
    const legacy = { projectId: "p1", canvasData: draft(9)!.canvasData } as unknown as DraftRecord;
    expect(isDraftNewer(legacy, 0)).toBe(false);
  });
});

describe("saveDraft 代际单调", () => {
  it("更旧代际的写入被拒绝，不覆盖已固化的更新草稿", async () => {
    await saveDraft("p1", 3, { ...draft(3)!.canvasData });
    await saveDraft("p1", 2, { ...draft(3)!.canvasData, minimapVisible: false });
    const record = await loadDraft("p1");
    expect(record?.rev).toBe(3);
    expect(record?.canvasData.minimapVisible).toBe(true);
  });

  it("同代际或更新代际正常覆盖", async () => {
    await saveDraft("p1", 2, { ...draft(2)!.canvasData });
    await saveDraft("p1", 2, { ...draft(2)!.canvasData, snapToGrid: true });
    expect((await loadDraft("p1"))?.canvasData.snapToGrid).toBe(true);
    await saveDraft("p1", 4, { ...draft(2)!.canvasData });
    expect((await loadDraft("p1"))?.rev).toBe(4);
  });

  it("旧格式记录（无 rev 字段）可被覆盖", async () => {
    mocks.records.set("p1", { projectId: "p1", canvasData: draft(9)!.canvasData });
    await saveDraft("p1", 2, { ...draft(2)!.canvasData });
    expect((await loadDraft("p1"))?.rev).toBe(2);
  });
});

describe("并发固化串行性（单事务）", () => {
  it("并发写入按事务创建顺序生效：旧代际不回退覆盖新代际", async () => {
    const data = draft(3)!.canvasData;
    const writeNew = saveDraft("p1", 3, data);
    const writeOld = saveDraft("p1", 2, { ...data, minimapVisible: false });
    await Promise.all([writeNew, writeOld]);
    const record = await loadDraft("p1");
    expect(record?.rev).toBe(3);
    expect(record?.canvasData.minimapVisible).toBe(true);
  });

  it("并发条件清理与写入两种交错顺序都不丢新草稿", async () => {
    const data = draft(3)!.canvasData;
    // 写入事务先创建，清理事务后创建：清理读到新代际，保留
    await Promise.all([saveDraft("p1", 3, data), clearStaleDraft("p1", 2)]);
    expect((await loadDraft("p1"))?.rev).toBe(3);

    // 清理事务先创建，写入事务后创建：先删旧记录，新草稿随后落下
    mocks.records.clear();
    await Promise.all([clearStaleDraft("p1", 2), saveDraft("p1", 3, data)]);
    expect((await loadDraft("p1"))?.rev).toBe(3);
  });
});

describe("clearStaleDraft 条件清理", () => {
  it("代际不超过 serverRev 的草稿被删除", async () => {
    await saveDraft("p1", 2, { ...draft(2)!.canvasData });
    await clearStaleDraft("p1", 3);
    expect(await loadDraft("p1")).toBeNull();
  });

  it("较新代际的草稿保留（承接在途保存后的未落库改动）", async () => {
    await saveDraft("p1", 4, { ...draft(4)!.canvasData });
    await clearStaleDraft("p1", 3);
    expect((await loadDraft("p1"))?.rev).toBe(4);
  });

  it("旧格式记录（无 rev 字段）视为陈旧，直接删除", async () => {
    mocks.records.set("p1", { projectId: "p1", canvasData: draft(9)!.canvasData });
    await clearStaleDraft("p1", 1);
    expect(await loadDraft("p1")).toBeNull();
  });
});
