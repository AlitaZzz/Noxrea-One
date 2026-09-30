/**
 * 画布编辑会话事件处理回归测试（handshake / evict）。
 *
 * 覆盖核心不变量：
 *   - 握手采纳（初始加载）：adoptProject upsert 摘要、restoreFromProject 程序化
 *     恢复内容、撤销历史归零、持有租约令牌——编辑权与内容原子绑定。
 *   - 采纳失败不留半持有租约：adoptProject 返回 null → 拒绝握手且未持有令牌。
 *   - 断线重连（同令牌）：编辑权仍有效——只同步领先版本，绝不恢复内容
 *     （保护本地未保存编辑），不重置撤销历史。
 *   - 令牌不同：本页已知失效 → 与 evict 同等收尾（同步版本 + notifyEvicted，
 *     不静默夺回编辑权）；未失效 → 服务端已重新签发（空置超宽限后房间重建 /
 *     SPA 返回），无缝续接——更新令牌与版本，内容不动（保护本地未保存编辑）。
 *   - evict：同步服务端 revision（store 内有单调保护）并联动 saveManager 停用保存。
 *   - 协议防御：载荷不合法 / 项目 id 不一致 → 拒绝且不误标过期（协议错误
 *     ≠ 编辑权变更，由连接层按传输失败收敛）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  restoreFromProject: vi.fn(),
  clearHistory: vi.fn(),
  runSuppressed: vi.fn(),
  notifyEvicted: vi.fn(),
  updateProjectRevision: vi.fn(),
  adoptProject: vi.fn(),
  saveExpired: false,
}));

vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({ restoreFromProject: mocks.restoreFromProject }),
  },
}));

vi.mock("@/features/canvas/stores/history-store", () => ({
  useHistoryStore: {
    getState: () => ({ clear: mocks.clearHistory }),
  },
}));

vi.mock("@/features/canvas/agent/user-action-tracker", () => ({
  runSuppressed: (fn: () => void) => mocks.runSuppressed(fn),
}));

vi.mock("@/features/project/save-manager", () => ({
  saveManager: {
    notifyEvicted: (...args: unknown[]) => mocks.notifyEvicted(...args),
    isExpired: () => mocks.saveExpired,
  },
}));

vi.mock("@/features/project/store", () => ({
  useProjectStore: {
    getState: () => ({
      updateProjectRevision: (...args: unknown[]) => mocks.updateProjectRevision(...args),
      adoptProject: (...args: unknown[]) => mocks.adoptProject(...args),
    }),
  },
}));

// 事件处理器不触网；连接层（useCanvasSession）不在本套件覆盖范围
vi.mock("@/lib/api/client", () => ({ apiStream: vi.fn() }));
vi.mock("@/lib/sse", () => ({
  readSseStream: vi.fn(),
  SSE_CONNECT_TIMEOUT_MS: 30_000,
  SSE_WATCHDOG_CHECK_MS: 5_000,
  SSE_WATCHDOG_TIMEOUT_MS: 30_000,
}));

// 租约模块零依赖，用真实实现锁定持有 / keyed 读取语义
import { getCanvasLease, resetCanvasLease, setCanvasLease } from "@/features/project/canvas-lease";
import {
  handleCanvasHandshake,
  handleEvictEvent,
} from "@/features/project/use-canvas-session";

const ADOPTED = { id: "p1", name: "A", revision: 4, nodes: [], edges: [] };

const VALID_PAYLOAD = {
  lease: 42,
  project: {
    id: "p1",
    name: "A",
    revision: 4,
    updatedAt: "2026-01-01T00:00:00Z",
    canvasData: { nodes: [], edges: [] },
  },
};

describe("画布会话事件处理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCanvasLease();
    mocks.saveExpired = false;
    mocks.runSuppressed.mockImplementation((fn: () => void) => fn());
    mocks.adoptProject.mockReturnValue(ADOPTED);
  });

  describe("evict（编辑权被其他页面实例取得）", () => {
    it("同步服务端 revision 并联动 saveManager 停用保存", () => {
      handleEvictEvent("p1", { revision: 5 });

      expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 5);
      expect(mocks.notifyEvicted).toHaveBeenCalledTimes(1);
    });

    it("无 revision / 非数字 revision：仍停用保存，但不写版本", () => {
      handleEvictEvent("p1", {});
      handleEvictEvent("p1", { revision: "5" });

      expect(mocks.updateProjectRevision).not.toHaveBeenCalled();
      expect(mocks.notifyEvicted).toHaveBeenCalledTimes(2);
    });
  });

  describe("handshake（初始加载：采纳快照与租约）", () => {
    it("采纳快照并持有租约：恢复内容（程序化写入）、撤销历史归零", () => {
      expect(handleCanvasHandshake("p1", VALID_PAYLOAD)).toBe("adopted");

      expect(mocks.adoptProject).toHaveBeenCalledWith(VALID_PAYLOAD.project);
      expect(mocks.runSuppressed).toHaveBeenCalledTimes(1);
      expect(mocks.restoreFromProject).toHaveBeenCalledWith("p1", ADOPTED);
      expect(mocks.clearHistory).toHaveBeenCalledTimes(1);
      expect(getCanvasLease("p1")).toBe(42);
      // 采纳路径是取得编辑权，不是被驱逐
      expect(mocks.notifyEvicted).not.toHaveBeenCalled();
      // 采纳路径不按「重连版本同步」写版本
      expect(mocks.updateProjectRevision).not.toHaveBeenCalled();
    });

    it("采纳失败（映射不出项目）：拒绝握手且不遗留半持有的租约", () => {
      mocks.adoptProject.mockReturnValue(null);

      expect(handleCanvasHandshake("p1", VALID_PAYLOAD)).toBe("rejected");

      expect(getCanvasLease("p1")).toBeNull();
      expect(mocks.restoreFromProject).not.toHaveBeenCalled();
      expect(mocks.clearHistory).not.toHaveBeenCalled();
    });

    it.each([
      ["lease 缺失", { project: VALID_PAYLOAD.project }],
      ["lease 非正整数", { lease: 0, project: VALID_PAYLOAD.project }],
      ["lease 非整数", { lease: 1.5, project: VALID_PAYLOAD.project }],
      ["project 缺失", { lease: 42 }],
      ["project.id 为空", { lease: 42, project: { ...VALID_PAYLOAD.project, id: "" } }],
      ["project.name 缺失", { lease: 42, project: { id: "p1", updatedAt: "2026-01-01T00:00:00Z" } }],
      ["updatedAt 缺失", { lease: 42, project: { id: "p1", name: "A" } }],
    ])("载荷不合法（%s）：拒绝且不误标过期、不持有租约", (_label, data) => {
      expect(handleCanvasHandshake("p1", data)).toBe("rejected");

      // 协议错误 ≠ 编辑权变更：不触发驱逐联动，由连接层按传输失败收敛
      expect(mocks.notifyEvicted).not.toHaveBeenCalled();
      expect(mocks.adoptProject).not.toHaveBeenCalled();
      expect(getCanvasLease("p1")).toBeNull();
    });

    it("协议防御：握手项目与订阅项目不一致 → 拒绝", () => {
      const data = { lease: 42, project: { ...VALID_PAYLOAD.project, id: "p2" } };

      expect(handleCanvasHandshake("p1", data)).toBe("rejected");

      expect(mocks.adoptProject).not.toHaveBeenCalled();
      expect(getCanvasLease("p1")).toBeNull();
    });
  });

  describe("handshake（断线重连：已持有租约）", () => {
    beforeEach(() => {
      setCanvasLease("p1", 42);
    });

    it("同令牌 + revision 领先：仅同步版本，不恢复内容、不重置历史", () => {
      const data = { lease: 42, project: { ...VALID_PAYLOAD.project, revision: 9 } };

      expect(handleCanvasHandshake("p1", data)).toBe("adopted");

      expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 9);
      expect(mocks.adoptProject).not.toHaveBeenCalled();
      expect(mocks.restoreFromProject).not.toHaveBeenCalled(); // 保护本地未保存编辑
      expect(mocks.clearHistory).not.toHaveBeenCalled();
      expect(mocks.notifyEvicted).not.toHaveBeenCalled();
    });

    it("同令牌 + revision 非数字：接受握手，不同步版本", () => {
      const data = { lease: 42, project: { id: "p1", name: "A", updatedAt: "2026-01-01T00:00:00Z" } };

      expect(handleCanvasHandshake("p1", data)).toBe("adopted");
      expect(mocks.updateProjectRevision).not.toHaveBeenCalled();
    });

    it("令牌不同且本页已知失效（断线期间被接管）：按 evict 收尾，不静默夺回", () => {
      const data = { lease: 99, project: { ...VALID_PAYLOAD.project, revision: 9 } };
      mocks.saveExpired = true;

      expect(handleCanvasHandshake("p1", data)).toBe("expired");

      expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 9);
      expect(mocks.notifyEvicted).toHaveBeenCalledTimes(1);
      expect(mocks.restoreFromProject).not.toHaveBeenCalled();
      // 已失效页面不得更新槽位令牌：编辑权已属他人，唯一出口是刷新
      expect(getCanvasLease("p1")).toBe(42);
    });

    it("令牌不同但未失效（空置超宽限后重新签发 / SPA 返回）：无缝续接", () => {
      const data = { lease: 99, project: { ...VALID_PAYLOAD.project, revision: 9 } };

      expect(handleCanvasHandshake("p1", data)).toBe("adopted");

      // 更新令牌与版本；本地未保存编辑保护：不恢复内容、不重置历史、不驱逐
      expect(getCanvasLease("p1")).toBe(99);
      expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 9);
      expect(mocks.notifyEvicted).not.toHaveBeenCalled();
      expect(mocks.restoreFromProject).not.toHaveBeenCalled();
      expect(mocks.clearHistory).not.toHaveBeenCalled();
      expect(mocks.adoptProject).not.toHaveBeenCalled();
    });

    it("单租约槽位：切换项目后旧项目令牌不再可寻址（keyed 读取天然惰性）", () => {
      const data = { lease: 7, project: { ...VALID_PAYLOAD.project, id: "p2" } };

      expect(handleCanvasHandshake("p2", data)).toBe("adopted");

      expect(getCanvasLease("p2")).toBe(7);
      expect(getCanvasLease("p1")).toBeNull();
    });
  });
});
