/**
 * 上传进度 store（阶段化进度值）单测。
 * 锁住 phase-state 方案的两个关键点：
 * 1. begin 初值即哈希态——与 direct 模式 runOne 的同步首报同值，渲染上不闪 0% 帧；
 * 2. update 按「相位 + 字段」浅相等去重——同一进度值不触发订阅通知，
 *    相位切换（哈希 0 → 传输 0）不算同值，必须通知。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUploadProgressStore } from "@/features/canvas/upload/upload-progress-store";

const store = () => useUploadProgressStore.getState();

beforeEach(() => {
  store().clearAll();
});

describe("上传进度 store", () => {
  it("begin 初值为哈希态 0 字节，并绑定版本", () => {
    store().begin("n1", 7);

    expect(store().byNodeId.get("n1")).toEqual({
      version: 7,
      progress: { phase: "hashing", loadedBytes: 0 },
    });
  });

  it("同相位同值的 update 去重不通知，值或相位变化才通知", () => {
    store().begin("n1", 1);
    const listener = vi.fn();
    const unsub = useUploadProgressStore.subscribe(listener);

    // 与 begin 初值同值：去重
    store().update("n1", 1, { phase: "hashing", loadedBytes: 0 });
    expect(listener).not.toHaveBeenCalled();

    // 哈希已读字节推进：通知
    store().update("n1", 1, { phase: "hashing", loadedBytes: 1024 });
    expect(store().byNodeId.get("n1")?.progress).toEqual({ phase: "hashing", loadedBytes: 1024 });
    expect(listener).toHaveBeenCalledTimes(1);

    // 传输百分比重复上报同值：只在首次变化时通知
    store().update("n1", 1, { phase: "uploading", pct: 33 });
    store().update("n1", 1, { phase: "uploading", pct: 33 });
    expect(listener).toHaveBeenCalledTimes(2);

    // 相位切换即不同值（哈希 0 → 传输 0）：必须通知
    store().begin("n2", 1);
    store().update("n2", 1, { phase: "uploading", pct: 0 });
    expect(store().byNodeId.get("n2")?.progress).toEqual({ phase: "uploading", pct: 0 });

    unsub();
  });

  it("版本闸门：版本不匹配的 update 与 clear 是 no-op", () => {
    store().begin("n1", 1);

    store().update("n1", 2, { phase: "uploading", pct: 50 });
    expect(store().byNodeId.get("n1")?.progress).toEqual({ phase: "hashing", loadedBytes: 0 });

    store().update("n1", 1, { phase: "uploading", pct: 50 });
    store().clear("n1", 2);
    expect(store().byNodeId.has("n1")).toBe(true);

    // 带匹配版本与不带版本的 clear 都移除
    store().clear("n1", 1);
    expect(store().byNodeId.has("n1")).toBe(false);

    store().begin("n1", 3);
    store().clear("n1");
    expect(store().byNodeId.has("n1")).toBe(false);
  });
});
