/**
 * 画布编辑会话事件处理回归测试（handshake / evict）。
 *
 * 覆盖核心不变量：
 *   - 握手采纳（初始加载）：canvas 解析 → entity 摘要 upsert → canvas 恢复内容、
 *     撤销历史归零、持有租约令牌——编辑权与内容原子绑定，两步之间无 await。
 *   - 非法载荷：拒绝且不写任何 entity/canvas 状态，不持有租约。
 *   - 断线重连（同令牌）：编辑权从未离开本页——只同步领先版本，绝不恢复内容
 *     （保护本地未保存编辑），不重置撤销历史。
 *   - 令牌不同：服务端发生过 fresh join 轮换，编辑权曾易主。一律与 evict 同等
 *     收尾（同步版本 + notifyEvicted，不静默续接）——唯一出口是刷新后重走采纳。
 *   - evict：同步服务端 revision（entity 内有单调保护）并联动 saveManager 停用保存。
 *   - 协议防御：载荷不合法 / 项目 id 不一致 → 拒绝且不误标过期。
 * @vitest-environment jsdom
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  restoreFromProject: vi.fn(),
  clearHistory: vi.fn(),
  runSuppressed: vi.fn(),
  notifyEvicted: vi.fn(),
  setBaselineFromCurrent: vi.fn(),
  updateProjectRevision: vi.fn(),
  upsertProjectSummary: vi.fn(),
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

vi.mock("@/features/canvas/persistence/save-manager", () => ({
  saveManager: {
    notifyEvicted: (...args: unknown[]) => mocks.notifyEvicted(...args),
    setBaselineFromCurrent: (...args: unknown[]) => mocks.setBaselineFromCurrent(...args),
  },
}));

vi.mock("@/entities/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/entities/project")>()),
  updateProjectRevision: (...args: unknown[]) => mocks.updateProjectRevision(...args),
  upsertProjectSummary: (...args: unknown[]) => mocks.upsertProjectSummary(...args),
}));

// 事件处理器不触网（apiStream / readSseStream 为桩，供 useCanvasSession
// 会话边界用例挂载 hook 而不建立真实连接）
vi.mock("@/lib/api/client", () => ({ apiStream: vi.fn() }));
vi.mock("@/lib/sse", () => ({
  readSseStream: vi.fn(),
  SSE_CONNECT_TIMEOUT_MS: 30_000,
  SSE_WATCHDOG_CHECK_MS: 5_000,
  SSE_WATCHDOG_TIMEOUT_MS: 30_000,
}));

// 租约模块零依赖，用真实实现锁定持有 / keyed 读取语义
import { clearCanvasLease, getCanvasLease, setCanvasLease } from "@/features/canvas/persistence/canvas-lease";
import { handleCanvasHandshake, handleEvictEvent } from "@/features/canvas/session/session-events";
import { useCanvasSession } from "@/features/canvas/session/use-canvas-session";

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

const NODE = { id: "n1", type: "image-node", position: { x: 0, y: 0 }, data: {} };
const EDGE = { id: "e1", source: "n1", target: "n2" };

describe("画布会话事件处理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 租约模块是单槽位；清掉本文件用到的项目即可复位到「未持有」
    clearCanvasLease("p1");
    clearCanvasLease("p2");
    mocks.runSuppressed.mockImplementation((fn: () => void) => fn());
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
    it("canvas 校验 → entity 摘要 upsert → canvas 恢复，且持有租约", () => {
      expect(handleCanvasHandshake("p1", VALID_PAYLOAD)).toBe("adopted");

      // entity 摘要 upsert：只写摘要字段，不写画布内容
      expect(mocks.upsertProjectSummary).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p1", name: "A", revision: 4, nodeCount: 0 }),
      );
      expect(mocks.upsertProjectSummary.mock.calls[0][0]).not.toHaveProperty("nodes");
      // canvas 恢复：程序化写入，撤销历史归零
      expect(mocks.runSuppressed).toHaveBeenCalledTimes(1);
      expect(mocks.restoreFromProject).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ id: "p1", name: "A", revision: 4, nodes: [], edges: [] }),
      );
      // 摘要 upsert 先于内容恢复，两步之间无 await
      expect(mocks.upsertProjectSummary.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.restoreFromProject.mock.invocationCallOrder[0]);
      expect(mocks.setBaselineFromCurrent).toHaveBeenCalledWith("p1");
      expect(mocks.clearHistory).toHaveBeenCalledTimes(1);
      expect(getCanvasLease("p1")).toBe(42);
      // 采纳路径是取得编辑权，不是被驱逐
      expect(mocks.notifyEvicted).not.toHaveBeenCalled();
      // 采纳路径不按「重连版本同步」写版本
      expect(mocks.updateProjectRevision).not.toHaveBeenCalled();
    });

    it.each([
      ["lease 缺失", { project: VALID_PAYLOAD.project }],
      ["lease 非正整数", { lease: 0, project: VALID_PAYLOAD.project }],
      ["lease 非整数", { lease: 1.5, project: VALID_PAYLOAD.project }],
      ["project 缺失", { lease: 42 }],
      ["project.id 为空", { lease: 42, project: { ...VALID_PAYLOAD.project, id: "" } }],
      ["project.name 缺失", { lease: 42, project: { id: "p1", updatedAt: "2026-01-01T00:00:00Z" } }],
      ["updatedAt 缺失", { lease: 42, project: { id: "p1", name: "A" } }],
      ["revision 非数字", { lease: 42, project: { ...VALID_PAYLOAD.project, revision: "4" } }],
      ["revision 非正整数", { lease: 42, project: { ...VALID_PAYLOAD.project, revision: 0 } }],
      ["canvasData 非对象", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: "x" } }],
      ["nodes 非数组", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: "x", edges: [] } } }],
      ["nodes 为对象", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: {}, edges: [] } } }],
      ["节点为 null", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [null], edges: [] } } }],
      ["节点缺 position", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [{ ...NODE, position: undefined }], edges: [] } } }],
      ["节点 position 非数值", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [{ ...NODE, position: { x: "0", y: 0 } }], edges: [] } } }],
      ["节点 data 非对象", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [{ ...NODE, data: null }], edges: [] } } }],
      ["节点 id 重复", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [NODE, { ...NODE }], edges: [] } } }],
      ["edges 非数组", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [], edges: {} } } }],
      ["边为 null", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [], edges: [null] } } }],
      ["边缺 target", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [], edges: [{ ...EDGE, target: undefined }] } } }],
      ["边 id 重复", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [], edges: [EDGE, { ...EDGE }] } } }],
      ["viewport 非法", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0 } } } }],
      ["minimapVisible 非布尔", { lease: 42, project: { ...VALID_PAYLOAD.project, canvasData: { nodes: [], edges: [], minimapVisible: "yes" } } }],
    ])("载荷不合法（%s）：拒绝且不写任何状态、不误标过期", (_label, data) => {
      expect(handleCanvasHandshake("p1", data)).toBe("rejected");

      // 协议错误 ≠ 编辑权变更：不触发驱逐联动，由连接层按传输失败收敛
      expect(mocks.notifyEvicted).not.toHaveBeenCalled();
      // 非法载荷不产生任何 entity / canvas 状态写入
      expect(mocks.upsertProjectSummary).not.toHaveBeenCalled();
      expect(mocks.restoreFromProject).not.toHaveBeenCalled();
      expect(mocks.clearHistory).not.toHaveBeenCalled();
      expect(getCanvasLease("p1")).toBeNull();
    });

    it("协议防御：握手项目与订阅项目不一致 → 拒绝", () => {
      const data = { lease: 42, project: { ...VALID_PAYLOAD.project, id: "p2" } };

      expect(handleCanvasHandshake("p1", data)).toBe("rejected");

      expect(mocks.upsertProjectSummary).not.toHaveBeenCalled();
      expect(mocks.restoreFromProject).not.toHaveBeenCalled();
      expect(getCanvasLease("p1")).toBeNull();
    });

    it("revision 缺省：解析为 1 并恢复内容", () => {
      const { revision: _revision, ...project } = VALID_PAYLOAD.project;

      expect(handleCanvasHandshake("p1", { lease: 42, project })).toBe("adopted");

      expect(mocks.upsertProjectSummary).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p1", revision: 1 }),
      );
      expect(mocks.restoreFromProject).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ revision: 1 }),
      );
    });

    it("合法节点与边：摘要按首图投影，内容原样恢复", () => {
      const project = {
        ...VALID_PAYLOAD.project,
        canvasData: {
          nodes: [
            { id: "n1", type: "image-node", position: { x: 0, y: 0 }, data: { src: "/a.png" } },
            { id: "g1", type: "group", position: { x: 0, y: 0 }, data: {} },
          ],
          edges: [{ id: "e1", source: "n1", target: "g1" }],
        },
      };

      expect(handleCanvasHandshake("p1", { lease: 42, project })).toBe("adopted");

      expect(mocks.upsertProjectSummary).toHaveBeenCalledWith(
        expect.objectContaining({ nodeCount: 2, thumbnail: "/a.png" }),
      );
      expect(mocks.restoreFromProject).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ nodes: project.canvasData.nodes, edges: project.canvasData.edges }),
      );
    });

    it("agentModel: null（增量清除）视为缺省，不拒绝", () => {
      const project = {
        ...VALID_PAYLOAD.project,
        canvasData: { nodes: [], edges: [], agentModel: null },
      };

      expect(handleCanvasHandshake("p1", { lease: 42, project })).toBe("adopted");

      expect(mocks.restoreFromProject).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ agentModel: undefined }),
      );
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
      expect(mocks.upsertProjectSummary).not.toHaveBeenCalled();
      expect(mocks.restoreFromProject).not.toHaveBeenCalled(); // 保护本地未保存编辑
      expect(mocks.clearHistory).not.toHaveBeenCalled();
      expect(mocks.notifyEvicted).not.toHaveBeenCalled();
    });

    it.each([
      "SPA 离开期间他人推进内容（房间超宽限重建后重进）",
      "断线窗口错过 evict（断线期间被接管，重连拿到新令牌）",
    ])("令牌不同（%s）：一律按 evict 收尾，绝不静默续接", () => {
      const data = { lease: 99, project: { ...VALID_PAYLOAD.project, revision: 9 } };

      expect(handleCanvasHandshake("p1", data)).toBe("expired");

      expect(mocks.updateProjectRevision).toHaveBeenCalledWith("p1", 9);
      expect(mocks.notifyEvicted).toHaveBeenCalledTimes(1);
      // 绝不静默续接：不恢复内容、不重置历史、不重新采纳
      expect(mocks.restoreFromProject).not.toHaveBeenCalled();
      expect(mocks.clearHistory).not.toHaveBeenCalled();
      expect(mocks.upsertProjectSummary).not.toHaveBeenCalled();
      // 编辑权曾易主，旧槽位不得被新令牌覆盖：唯一出口是刷新后重走采纳
      expect(getCanvasLease("p1")).toBe(42);
    });

    it("单租约槽位：切换项目后旧项目令牌不再可寻址（keyed 读取天然惰性）", () => {
      const data = { lease: 7, project: { ...VALID_PAYLOAD.project, id: "p2" } };

      expect(handleCanvasHandshake("p2", data)).toBe("adopted");

      expect(getCanvasLease("p2")).toBe(7);
      expect(getCanvasLease("p1")).toBeNull();
    });
  });

  describe("租约生命周期（clearCanvasLease）", () => {
    it("keyed 清除：只清指定项目，其他项目槽位不受影响", () => {
      setCanvasLease("p1", 42);

      clearCanvasLease("p2");

      expect(getCanvasLease("p1")).toBe(42);
    });

    it("清除后重进：旧租约作废，握手必然重走采纳路径（restore 服务端快照）", () => {
      setCanvasLease("p1", 10); // 上次会话的旧令牌
      clearCanvasLease("p1");

      expect(handleCanvasHandshake("p1", VALID_PAYLOAD)).toBe("adopted");
      // 走的是采纳分支：恢复服务端内容 + 归零撤销历史 + 持有新令牌
      expect(mocks.restoreFromProject).toHaveBeenCalledTimes(1);
      expect(mocks.clearHistory).toHaveBeenCalledTimes(1);
      expect(getCanvasLease("p1")).toBe(VALID_PAYLOAD.lease);
    });
  });

  describe("useCanvasSession（会话边界）", () => {
    it("会话开始即作废同项目残留租约：重进不可能无缝续接（RR-02 根因）", () => {
      setCanvasLease("p1", 10); // 模拟上次会话残留的令牌

      renderHook(() => useCanvasSession("p1"));

      // effect setup 同步清租约——本次握手的 held 必为 null，走采纳路径
      expect(getCanvasLease("p1")).toBeNull();
    });
  });
});
