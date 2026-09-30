/**
 * 画布编辑权租约测试。
 *
 * 核心语义：
 * - 全新页面实例（打开/刷新）抢占并轮换租约令牌，断线重连（同 sid）绝不抢占；
 * - 令牌轮换后旧持有者的令牌立即失效——其迟到写入被 isCurrentLease 结构性拒绝
 *   （lost update 不可达，fencing token）；
 * - 令牌计数器全局单调：房间销毁 / 宽限释放后重建不复位，旧令牌永不复活；
 * - withProjectGate 串行化每项目写临界区：握手（轮换+快照读）与内容写不交错。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  broadcastToOthers,
  currentLeaseToken,
  destroyRoom,
  EMPTY_ROOM_GRACE_MS,
  gateCount,
  isCurrentLease,
  joinCanvasRoom,
  leaveCanvasRoom,
  resetCanvasPresence,
  withProjectGate,
} from "./editor-lease";

function collector() {
  const events: Array<{ event: string; data: unknown }> = [];
  return {
    events,
    emit: (event: string, data: unknown) => {
      events.push({ event, data });
    },
  };
}

/** 手工控制的 deferred promise：测试 gate 临界区的挂起与串行 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetCanvasPresence();
});

describe("joinCanvasRoom 抢占语义", () => {
  it("首个页面实例进入：成为持有者，无广播", () => {
    const a = collector();
    const join = joinCanvasRoom("p1", "A", a.emit);
    expect(join).toMatchObject({ fresh: true, superseded: false });
    expect(isCurrentLease("p1", join.leaseToken)).toBe(true);
    expect(a.events).toEqual([]);
  });

  it("全新页面实例进入：抢占编辑权并轮换令牌（evict 广播由路由层执行）", () => {
    const a = collector();
    const b = collector();
    const first = joinCanvasRoom("p1", "A", a.emit);

    const join = joinCanvasRoom("p1", "B", b.emit);
    expect(join).toMatchObject({ fresh: true, superseded: false });
    // presence 层是纯状态机：广播 evict 由路由根据 fresh 标志执行
    // （revision 数据只存在于路由层），此处不应产生任何事件
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
    // 编辑权已移交：A 的令牌失效，B 的令牌生效
    expect(isCurrentLease("p1", first.leaseToken)).toBe(false);
    expect(isCurrentLease("p1", join.leaseToken)).toBe(true);
  });

  it("同 sid 重连：回归不抢占，租约令牌不变", () => {
    const a = collector();
    const join = joinCanvasRoom("p1", "A", a.emit);

    const rejoin = joinCanvasRoom("p1", "A", a.emit);
    expect(rejoin).toMatchObject({ fresh: false, superseded: false });
    expect(rejoin.leaseToken).toBe(join.leaseToken);
    expect(isCurrentLease("p1", join.leaseToken)).toBe(true);
    expect(a.events).toEqual([]);
  });

  it("断线期间被抢占：重连判定为 superseded（路由据此补发 evict）", () => {
    const a = collector();
    const b = collector();
    const first = joinCanvasRoom("p1", "A", a.emit);
    // B 先进房取得编辑权，A 的断线不会让房间变空（seen 保留 A）
    const second = joinCanvasRoom("p1", "B", b.emit);
    leaveCanvasRoom("p1", "A", first.connId);

    const rejoin = joinCanvasRoom("p1", "A", a.emit);
    expect(rejoin).toMatchObject({ fresh: false, superseded: true });
    expect(rejoin.leaseToken).toBe(second.leaseToken);
    expect(isCurrentLease("p1", first.leaseToken)).toBe(false);
    expect(isCurrentLease("p1", second.leaseToken)).toBe(true);
  });

  it("多项目互不干扰：令牌按房间独立生效、全局计数不碰撞", () => {
    const a = collector();
    const first = joinCanvasRoom("p1", "A", a.emit);
    const second = joinCanvasRoom("p2", "B", a.emit);
    expect(second).toMatchObject({ fresh: true, superseded: false });
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(isCurrentLease("p1", first.leaseToken)).toBe(true);
    expect(isCurrentLease("p2", second.leaseToken)).toBe(true);
    // 跨项目令牌互不认可
    expect(isCurrentLease("p2", first.leaseToken)).toBe(false);
    expect(isCurrentLease("p1", second.leaseToken)).toBe(false);
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
    const second = joinCanvasRoom("p1", "B", b.emit);
    expect(currentLeaseToken("p1")).toBe(second.leaseToken);

    // A 同 sid 重连：不判全新进入、不反踢 B，自身被判 superseded（路由补发 evict）
    const rejoin = joinCanvasRoom("p1", "A", a.emit);
    expect(rejoin).toMatchObject({ fresh: false, superseded: true });
    expect(isCurrentLease("p1", second.leaseToken)).toBe(true);
  });

  it("房间空置超过宽限：记忆释放，同 sid 再进入视为全新并轮换新令牌", () => {
    vi.useFakeTimers();
    try {
      const a = collector();
      const first = joinCanvasRoom("p1", "A", a.emit);
      leaveCanvasRoom("p1", "A", first.connId);

      // 空置超过宽限：房间记忆失效，原持有者的回归按全新进入处理
      vi.advanceTimersByTime(EMPTY_ROOM_GRACE_MS + 1);
      const rejoin = joinCanvasRoom("p1", "A", a.emit);
      expect(rejoin.fresh).toBe(true);
      // 全局计数器不复位：新令牌 ≠ 旧令牌，旧令牌永不复活
      expect(rejoin.leaseToken).not.toBe(first.leaseToken);
      expect(isCurrentLease("p1", first.leaseToken)).toBe(false);
      expect(isCurrentLease("p1", rejoin.leaseToken)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("同 sid 新旧连接交替：旧连接的 leave 不得误删新连接", () => {
    const a = collector();
    const other = collector();
    const first = joinCanvasRoom("p1", "A", a.emit);

    // 模拟 SSE 闪断重连：同 sid 新连接先建立，旧连接的断开回调后到。
    // 回归不轮换租约（轮换只发生在全新 sid 的抢占），持有权不变
    const second = joinCanvasRoom("p1", "A", a.emit);
    expect(second.connId).not.toBe(first.connId);
    expect(second.leaseToken).toBe(first.leaseToken);
    expect(isCurrentLease("p1", first.leaseToken)).toBe(true);
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
    expect(isCurrentLease("p1", first.leaseToken)).toBe(true);

    destroyRoom("p1");
    // 房间已不存在：令牌随之失效
    expect(isCurrentLease("p1", first.leaseToken)).toBe(false);
    expect(currentLeaseToken("p1")).toBeNull();

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

describe("租约令牌查询（isCurrentLease）", () => {
  it("未知项目与非数字令牌均失效", () => {
    expect(isCurrentLease("none", 1)).toBe(false);
    expect(isCurrentLease("none", undefined)).toBe(false);

    const a = collector();
    const { leaseToken } = joinCanvasRoom("p1", "A", a.emit);
    expect(isCurrentLease("p1", "not-a-number")).toBe(false);
    expect(isCurrentLease("p1", leaseToken + 0.5)).toBe(false);
    expect(isCurrentLease("p1", leaseToken)).toBe(true);
  });

  it("currentLeaseToken：观察当前生效令牌，未知项目返回 null", () => {
    expect(currentLeaseToken("none")).toBeNull();
    const a = collector();
    const { leaseToken } = joinCanvasRoom("p1", "A", a.emit);
    expect(currentLeaseToken("p1")).toBe(leaseToken);
  });
});

describe("withProjectGate 每项目写临界区", () => {
  it("同项目串行：前序未完成时后续写入不交错", async () => {
    const blocker = deferred();
    const order: string[] = [];

    const first = withProjectGate("p1", async () => {
      order.push("first:start");
      await blocker.promise;
      order.push("first:end");
    });
    const second = withProjectGate("p1", async () => {
      order.push("second");
    });

    // 推进微任务：first 开始执行并挂起在 blocker 上，second 因串行化尚未启动
    // （若实现未串行化，second 会立即执行使 order 长度不匹配）
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    blocker.resolve();
    await first;
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("前序失败不阻塞后序写入", async () => {
    const failed = withProjectGate("p1", async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");

    const result = await withProjectGate("p1", async () => "ok");
    expect(result).toBe("ok");
  });

  it("不同项目互不阻塞", async () => {
    const blocker = deferred();
    let resolveStarted!: () => void;
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });

    const a = withProjectGate("pA", async () => {
      resolveStarted();
      await blocker.promise;
    });
    await started;

    // pA 仍挂起：pB 的写入不被阻塞
    const b = await withProjectGate("pB", async () => "b");
    expect(b).toBe("b");

    blocker.resolve();
    await a;
  });

  it("gate 返回值与错误原样透传", async () => {
    const value = await withProjectGate("p1", async () => 42);
    expect(value).toBe(42);
    const err = withProjectGate("p1", async () => {
      throw new Error("lease lost");
    });
    await expect(err).rejects.toThrow("lease lost");
  });
});

describe("withProjectGate 条目生命周期（RR-03）", () => {
  /** 清理发生在完成后的微任务链上：推进一个宏任务确保全部落地 */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("gate 完成后条目被清理：Map 不随项目数无限增长", async () => {
    for (let i = 0; i < 5; i++) {
      await withProjectGate(`p-clean-${i}`, async () => i);
    }

    await flush();
    expect(gateCount()).toBe(0);
  });

  it("前序失败同样清理", async () => {
    await expect(
      withProjectGate("p-err", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    await flush();
    expect(gateCount()).toBe(0);
  });

  it("排队中的前序完成不误删条目：后继仍串行排队（误删会让 g3 与 g2 并发）", async () => {
    const order: string[] = [];
    const b1 = deferred();
    const b2 = deferred();

    const g1 = withProjectGate("p1", async () => {
      order.push("g1");
      await b1.promise;
    });
    const g2 = withProjectGate("p1", async () => {
      order.push("g2");
      await b2.promise;
    });

    // g1 完成（清理微任务触发），此时 g2 仍占用临界区
    b1.resolve();
    await g1;
    await flush();

    // 若清理误删了 g2 的条目，g3 会立即执行与 g2 重叠
    const g3 = withProjectGate("p1", async () => {
      order.push("g3");
    });
    b2.resolve();
    await g2;
    await g3;

    expect(order).toEqual(["g1", "g2", "g3"]);
    await flush();
    expect(gateCount()).toBe(0);
  });
});
