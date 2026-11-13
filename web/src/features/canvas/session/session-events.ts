/**
 * 画布编辑会话的事件语义。
 *
 * 与 SSE 连接生命周期分离：`useCanvasSession` 只负责传输、重连与终态，
 * 这里收敛 handshake / evict 对编辑权、项目摘要与画布状态的采纳规则，
 * 便于按协议帧直接回归。
 */

import { toProjectSummary, updateProjectRevision, upsertProjectSummary } from "@/entities/project";
import { runSuppressed } from "@/features/canvas/agent/user-action-tracker";
import { clearPreGenSnapshots } from "@/features/canvas/panels/use-generation-submit";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";

import { getCanvasLease, setCanvasLease } from "../persistence/canvas-lease";
import { saveManager } from "../persistence/save-manager";
import { parseCanvasProject } from "./project-payload";

/**
 * evict 事件处理：编辑权已被其他页面实例取得。同步服务端 revision
 * （entity 内有单调保护）、联动 saveManager 停用保存（过期弹窗出现后
 * 不再发出必 409 的请求），再进入过期态。
 */
export function handleEvictEvent(
  projectId: string,
  data: { revision?: unknown },
): void {
  const revision = typeof data.revision === "number" ? data.revision : undefined;
  if (revision !== undefined) {
    updateProjectRevision(projectId, revision);
  }
  saveManager.notifyEvicted(projectId);
}

/**
 * handshake 首帧处理。返回会话结局：
 *   "adopted"（会话建立）| "expired"（已知失效，弹窗接管）| "rejected"（协议错误）。
 *
 * 采纳顺序固定（Spec：canvas 校验 → entity 摘要 upsert → canvas 恢复）：
 * 1. canvas 解析器校验并映射 `data.project`，非法载荷不写任何状态；
 * 2. 摘要 upsert 进项目列表（直接经 URL 进画布时列表可能为空，顶栏名称与
 *    保存链路的 revision 都依赖此摘要）；
 * 3. 恢复画布内容（程序化写入，不进 agent 动作历史），撤销历史归零。
 * 第 2、3 步之间不得插入 await，避免摘要已更新而内容未恢复的半状态。
 *
 * - 未持有租约（初始加载）：采纳服务端快照与租约。
 * - 已持有同令牌（断线重连）：编辑权从未离开本页。revision 领先即本页断线
 *   期间的离线写入已落库——只同步版本，绝不恢复内容（保护本地未保存编辑）。
 * - 已持不同令牌：服务端发生过 fresh join 轮换，编辑权曾易主。令牌轮换不能
 *   证明本页内存画布仍对应当前租约的权威快照（SPA 离开期间他人推进内容 /
 *   断线窗口错过 evict），绝不静默续接：与 evict 同等收尾——同步版本 +
 *   notifyEvicted，过期弹窗引导刷新，刷新后重走采纳路径以服务端为准。
 * - 载荷不合法 / 项目 id 不一致：协议错误（服务端契约保证形状，理论不可达）——
 *   按传输失败处理，不标记过期（非编辑权变更）。
 */
export function handleCanvasHandshake(
  projectId: string,
  data: { project?: unknown; lease?: unknown },
): "adopted" | "rejected" | "expired" {
  const lease = data.lease;
  if (typeof lease !== "number" || !Number.isInteger(lease) || lease <= 0) {
    return "rejected";
  }
  const project = parseCanvasProject(data.project);
  // 协议防御：握手项目与订阅项目不一致（路由按 :id 读取，理论不可达）
  if (project === null || project.id !== projectId) return "rejected";

  const held = getCanvasLease(projectId);
  if (held !== null) {
    updateProjectRevision(projectId, project.revision);
    if (held === lease) {
      // 同一租约重连：服务端快照可能落后于本页内存（断线期间的本地改动，
      // 或 401 暂停期间的 dirty 内容），只解除会话暂停，绝不覆盖基线 / 内容。
      saveManager.notifySessionValid(projectId);
      return "adopted";
    }

    // 令牌不同 = 服务端发生过 fresh join 轮换 = 编辑权曾易主。本页可能错过
    // evict（断线窗口恰逢他人 fresh join、房间超宽限重建后重连），令牌轮换
    // 只证明「编辑权曾离开本页」，不能证明本页内存画布仍对应当前租约的权威
    // 快照——绝不静默续接：与 evict 同等收尾（同步版本 + notifyEvicted），
    // 过期弹窗引导刷新，刷新后槽位为空、重走采纳路径以服务端为准。
    saveManager.notifyEvicted(projectId);
    return "expired";
  }

  // 首次进入 / 跨项目返回：先恢复内容（恢复抛错时槽位未持有，重连握手重走
  // 采纳路径自愈），再持有租约。摘要 upsert 与内容恢复之间不插入 await。
  upsertProjectSummary(toProjectSummary(project));
  runSuppressed(() => useCanvasStore.getState().restoreFromProject(projectId, project));
  // 增量卸载保存必须以清洗后的画布状态为基线，避免把服务端已存在的节点
  // 误判为新增。
  saveManager.setBaselineFromCurrent(projectId);
  setCanvasLease(projectId, lease);
  useHistoryStore.getState().clear();
  // 预生成快照注册表随撤销历史一并归零：条目引用的是旧项目栈内快照，
  // popIfTop 按引用比对本就不会误弹新栈，清空只为收敛内存
  clearPreGenSnapshots();
  return "adopted";
}
