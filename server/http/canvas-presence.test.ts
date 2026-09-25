/**
 * 画布编辑权房间测试。
 *
 * 核心语义：全新页面实例（打开/刷新）抢占，断线重连（同 sid）绝不抢占；
 * 重连时若已不是持有者，服务端须能判定（由路由补发 evict 自愈）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  broadcastToOthers,
  canvasHolder,
  destroyRoom,
  EMPTY_ROOM_GRACE_MS,
  joinCanvasRoom,
  leaveCanvasRoom,
  resetCanvasPresence,
} from "./canvas-presence";

function collector() {
  const events: Array<{ event: string; data: unknown }> = [];
  return {
    events,
    emit: (event: string, data: unknown) => {
      events.push({ event, data });
    },
  };
}

beforeEach(() => {
  resetCanvasPresence();
});

describe("joinCanvasRoom 抢占语义", () => {
  it("首个页面实例进入：成为持有者，无广播", () => {
    const a = collector();
    const join = joinCanvasRoom("p1", "A", a.emit);
    expect(join).toMatchObject({ fresh: true, superseded: false });
    expect(canvasHolder("p1")).toBe("A");
    expect(a.events).toEqual([]);
  });

  it("全新页面实例进入：抢占编辑权（evict 广播由路由层执行）", () => {
    const a = collector();
    const b = collector();
    joinCanvasRoom("p1", "A", a.emit);

    const join = joinCanvasRoom("p1", "B", b.emit);
    expect(join).toMatchObject({ fresh: true, superseded: false });
    expect(canvasHolder("p1")).toBe("B");
    // presence 层是纯状态机：广播 evict 由路由根据 fresh 标志执行
    // （revision 数据只存在于路由层），此处不应产生任何事件
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
  });

  it("同 sid 重连：回归不抢占，持有权不变", () => {
    const a = collector();
    joinCanvasRoom("p1", "A", a.emit);

    const rejoin = joinCanvasRoom("p1", "A", a.emit);
    expect(rejoin).toMatchObject({ fresh: false, superseded: false });
    expect(canvasHolder("p1")).toBe("A");
    expect(a.events).toEqual([]);
  });

  it("断线期间被抢占：重连判定为 superseded（路由据此补发 evict）", () => {
    const a = collector();
    const b = collector();
    const first = joinCanvasRoom("p1", "A", a.emit);
    // B 先进房取得编辑权，A 的断线不会让房间变空（seen 保留 A）
    joinCanvasRoom("p1", "B", b.emit);
    leaveCanvasRoom("p1", "A", first.connId);

    const rejoin = joinCanvasRoom("p1", "A", a.emit);
    expect(rejoin).toMatchObject({ fresh: false, superseded: true });
    expect(canvasHolder("p1")).toBe("B");
  });

  it("多项目互不干扰", () => {
    const a = collector();
    joinCanvasRoom("p1", "A", a.emit);
    const join = joinCanvasRoom("p2", "B", a.emit);
    expect(join).toMatchObject({ fresh: true, superseded: false });
    expect(canvasHolder("p1")).toBe("A");
    expect(canvasHolder("p2")).toBe("B");
  });
});

describe("leaveCanvasRoom", () => {
  it("房间空置宽限内同 sid 重连：仍算回归，不抢占窗口期进入的他人", () => {
    const a = collector();
    const b = collector();
    const first = joinCanvasRoom("p1", "A", a.emit);
    // A 闪断：房间空置但不销毁（seen 保留 A）
    leaveCanvasRoom("p1", "A", first.connId);

    // 空置窗口内 B 进入取得编辑权
    joinCanvasRoom("p1", "B", b.emit);
    expect(canvasHolder("p1")).toBe("B");

    // A 同 sid 重连：不判全新进入、不反踢 B，自身被判 superseded（路由补发 evict）
    const rejoin = joinCanvasRoom("p1", "A", a.emit);
    expect(rejoin).toMatchObject({ fresh: false, superseded: true });
    expect(canvasHolder("p1")).toBe("B");
  });

  it("房间空置超过宽限：记忆释放，同 sid 再进入视为全新", () => {
    vi.useFakeTimers();
    try {
      const a = collector();
      const first = joinCanvasRoom("p1", "A", a.emit);
      leaveCanvasRoom("p1", "A", first.connId);

      // 空置超过宽限：房间记忆失效，原持有者的回归按全新进入处理
      vi.advanceTimersByTime(EMPTY_ROOM_GRACE_MS + 1);
      const rejoin = joinCanvasRoom("p1", "A", a.emit);
      expect(rejoin.fresh).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("同 sid 新旧连接交替：旧连接的 leave 不得误删新连接", () => {
    const a = collector();
    const other = collector();
    const first = joinCanvasRoom("p1", "A", a.emit);

    // 模拟刷新：新连接先建立，旧连接的断开回调后到
    const second = joinCanvasRoom("p1", "A", a.emit);
    expect(second.connId).not.toBe(first.connId);
    leaveCanvasRoom("p1", "A", first.connId);

    // 新连接仍能收到广播
    joinCanvasRoom("p1", "B", other.emit);
    broadcastToOthers("p1", "B", "evict", {});
    expect(a.events).toEqual([{ event: "evict", data: {} }]);
  });

  it("未知 connId 与不匹配的 sid 均静默幂等", () => {
    const a = collector();
    const { connId } = joinCanvasRoom("p1", "A", a.emit);
    expect(() => {
      leaveCanvasRoom("p1", "A", connId + 999);
      leaveCanvasRoom("p1", "other", connId);
      leaveCanvasRoom("none", "A", connId);
    }).not.toThrow();
  });

  it("destroyRoom：立即释放房间，在室连接的后续 leave 幂等跳过", () => {
    const a = collector();
    const first = joinCanvasRoom("p1", "A", a.emit);
    expect(canvasHolder("p1")).toBe("A");

    destroyRoom("p1");
    expect(canvasHolder("p1")).toBe("");

    // 在室连接断开：房间已不存在，静默跳过
    expect(() => leaveCanvasRoom("p1", "A", first.connId)).not.toThrow();

    // 同 sid 回归：房间已销毁重建，判全新进入
    const rejoin = joinCanvasRoom("p1", "A", a.emit);
    expect(rejoin.fresh).toBe(true);
  });
});

describe("broadcastToOthers", () => {
  it("单连接发送失败不阻塞其他接收者", () => {
    const good = collector();
    const badEmit = vi.fn(() => {
      throw new Error("connection dead");
    });
    joinCanvasRoom("p1", "bad", badEmit);
    joinCanvasRoom("p1", "good", good.emit);

    broadcastToOthers("p1", "none", "evict", { revision: 1 });
    expect(badEmit).toHaveBeenCalledTimes(1);
    expect(good.events).toEqual([{ event: "evict", data: { revision: 1 } }]);
  });

  it("排除自身：只发给其他页面实例", () => {
    const a = collector();
    const b = collector();
    joinCanvasRoom("p1", "A", a.emit);
    joinCanvasRoom("p1", "B", b.emit);

    broadcastToOthers("p1", "B", "evict", {});
    expect(a.events).toHaveLength(1);
    expect(b.events).toEqual([]);
  });
});
