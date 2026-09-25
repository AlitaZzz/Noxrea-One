/**
 * 画布编辑权房间（进程内）。
 *
 * 模型：同一画布同一时刻只有一个持有者（holder），**最后进入者取得编辑权**，
 * 先前的持有者立即收到 evict 并弹出过期提示。这是资源级编辑权租约，
 * 与登录态无关——被抢占方不需要登出，刷新即可重新取得编辑权。
 *
 * 连接以「页面实例 ID」（sid）标识：前端在每次整页加载时生成新 sid，
 * SSE 断线重连则复用同一 sid。据此区分两类事件：
 *   - 全新 sid（首次打开 / 刷新）→ 抢占，广播 evict 给房间内其他连接；
 *   - 已见过的 sid（闪断重连）  → 回归，不抢占；若发现自己已不是 holder，
 *     说明断线期间被他人抢占，只给「自己」补发 evict。
 *
 * 补发是必须的：断线期间若他人抢占，服务端 revision 可能并未变化
 * （对方只是打开还没保存），只靠版本号比对永远发现不了自己已失效。
 *
 * 房间空置（所有人断开）不立即销毁：宽限期内同 sid 重连仍按回归处理，
 * 否则「A 闪断 → 房间空置 → B 恰好在窗口内进入 → A 重连被误判全新进入
 * → 反踢正在编辑的 B」会造成编辑权来回震荡、B 的未保存编辑被作废。
 * 空置超过宽限的房间才释放记忆：此时原页面断线已久，内容大概率已旧，
 * 按「最后进入者取得编辑权」处理，落后由 sync / 保存撞 409 自愈。
 *
 * 单实例内存态即可满足当前部署（SQLite 单写，天然单实例）。未来多实例时
 * 只需把 broadcast / join 换成 Redis pub/sub 实现，本模块接口与调用方不变。
 */

type Emit = (event: string, data: unknown) => void;

interface Connection {
  /** 页面实例 ID */
  sid: string;
  /** 连接实例 ID：同一 sid 的新旧连接交替时，旧连接的 leave 不得误删新连接 */
  connId: number;
  emit: Emit;
}

interface Room {
  /** 当前持有编辑权的页面实例 */
  holder: string;
  connections: Map<number, Connection>;
  /** 曾加入过的页面实例：用于区分「全新进入」与「断线重连」 */
  seen: Set<string>;
  /** 连接数归零的时刻：空置宽限期内房间不销毁，同 sid 重连仍算回归 */
  emptyAt: number | null;
}

const rooms = new Map<string, Room>();

let nextConnId = 1;

/**
 * 空置宽限：覆盖前端最坏断链时长——看门狗 30s 判死静默连接 + 3s 重连间隔。
 * 宽限内的闪断重连一律算回归；超宽限的空房间才释放记忆（见模块注释）。
 * 导出供测试按真实宽限推进假时钟。
 */
export const EMPTY_ROOM_GRACE_MS = 60_000;

function roomOf(projectId: string): Room {
  let room = rooms.get(projectId);
  if (!room) {
    room = { holder: "", connections: new Map(), seen: new Set(), emptyAt: null };
    rooms.set(projectId, room);
  }
  return room;
}

/** 释放空置超过宽限的房间，防止无人问津的空房间无限堆积 */
function sweepIdleRooms(): void {
  const now = Date.now();
  for (const [projectId, room] of rooms) {
    if (room.connections.size === 0 && room.emptyAt !== null && now - room.emptyAt > EMPTY_ROOM_GRACE_MS) {
      rooms.delete(projectId);
    }
  }
}

export interface JoinResult {
  connId: number;
  /** 全新页面实例：抢占编辑权，调用方需向其他连接广播 evict */
  fresh: boolean;
  /** 回归但已不是持有者：断线期间被抢占，调用方需给该连接补发 evict */
  superseded: boolean;
}

/** 注册连接到画布房间。同 sid 的旧连接被替换（刷新时新旧连接会短暂交替） */
export function joinCanvasRoom(projectId: string, sid: string, emit: Emit): JoinResult {
  // 超宽限空房在此统一释放，roomOf 拿到的房间必然是：新建 / 有连接 / 宽限内空置
  sweepIdleRooms();
  const room = roomOf(projectId);
  room.emptyAt = null;

  const fresh = !room.seen.has(sid);
  room.seen.add(sid);

  // 同 sid 的旧连接整体替换：connId 换新后，旧连接的 leave 无法误删新连接
  for (const [id, conn] of room.connections) {
    if (conn.sid === sid) room.connections.delete(id);
  }

  const connId = nextConnId++;
  room.connections.set(connId, { sid, connId, emit });

  if (fresh) {
    room.holder = sid;
  }

  return { connId, fresh, superseded: !fresh && room.holder !== sid };
}

/**
 * 摘除连接（幂等）。房间空置时不销毁，仅标记空置时刻：宽限期内同 sid
 * 重连仍算回归（理由见模块注释），超宽限的空房间由 sweepIdleRooms 释放。
 */
export function leaveCanvasRoom(projectId: string, sid: string, connId: number): void {
  const room = rooms.get(projectId);
  if (!room) return;

  const conn = room.connections.get(connId);
  if (!conn || conn.sid !== sid) return;

  room.connections.delete(connId);
  if (room.connections.size === 0) {
    room.emptyAt = Date.now();
  }
}

/** 立即释放房间（项目删除时调用）：在室连接的后续 leave 因房间不存在而幂等跳过 */
export function destroyRoom(projectId: string): void {
  rooms.delete(projectId);
}

/** 向房间内除 excludeSid 外的所有连接广播事件 */
export function broadcastToOthers(projectId: string, excludeSid: string, event: string, data: unknown): void {
  const room = rooms.get(projectId);
  if (!room) return;

  for (const conn of room.connections.values()) {
    if (conn.sid === excludeSid) continue;
    try {
      conn.emit(event, data);
    } catch {
      // 单个连接发送失败（连接已死）不影响其余接收者；
      // 死连接由自身心跳 / 断连路径收敛
    }
  }
}

/**
 * 当前持有编辑权的页面实例（测试观察口：生产路径不直接消费，
 * 供测试断言抢占语义；将来管理端展示「谁在编辑」也可复用）。
 * 房间不存在时为空串；空置宽限期内的房间保留最后持有者（重连时的
 * superseded 判定依赖它）。
 */
export function canvasHolder(projectId: string): string {
  return rooms.get(projectId)?.holder ?? "";
}

/** 测试辅助：清空全部房间状态 */
export function resetCanvasPresence(): void {
  rooms.clear();
}
