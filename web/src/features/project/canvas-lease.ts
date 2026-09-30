/**
 * 画布编辑权租约令牌（页面实例级内存态）。
 *
 * 服务端 SSE 握手签发的 fencing token：内容写入必须原样携带，由服务端在
 * 写临界区内比对当前令牌裁决。模块级单值 + 项目寻址（keyed 读取），与
 * pageSessionId 同生命周期——均为页面实例级，刷新即重新握手取得新租约。
 * keyed 读取使跨项目残留天然惰性（换项目读取必为 null）；同项目的会话边界
 * （重新进入画布页）由 clearCanvasLease 在会话开始时作废旧租约，保证重进
 * 必然重走握手采纳、以服务端权威快照为准——旧令牌不再有「无缝续接」通道。
 */

let lease: { projectId: string; token: number } | null = null;

/** 记录当前页面实例在指定项目上持有的租约令牌（握手成功时调用） */
export function setCanvasLease(projectId: string, token: number): void {
  lease = { projectId, token };
}

/** 当前页面实例在指定项目上持有的租约令牌；未持有或项目不匹配返回 null */
export function getCanvasLease(projectId: string): number | null {
  return lease !== null && lease.projectId === projectId ? lease.token : null;
}

/**
 * 作废指定项目的租约（keyed：槽位不属于该项目时不动）。
 * 在画布会话开始（useCanvasSession 连接建立）时调用：离开页面期间令牌可能
 * 已被服务端轮换（他人 fresh join / 房间重建），本地内存内容不再对应权威
 * 快照，旧凭证必须作废——重新进入一律经握手采纳取得新租约与最新内容。
 */
export function clearCanvasLease(projectId: string): void {
  if (lease !== null && lease.projectId === projectId) {
    lease = null;
  }
}

/** 测试辅助：清空租约 */
export function resetCanvasLease(): void {
  lease = null;
}
