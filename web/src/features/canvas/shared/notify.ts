/**
 * 派生节点操作（片段截取 / 音频截取 / 变速 / 画面裁剪 / 分离音频 / 抓帧）共用的
 * 反馈 toast：busy 拒绝与「后端错误码 → 本地化文案（带兜底回落）」两个形状。
 * 形状由节点事件链路约定（clip.busy / error.<code> / 底部右侧 placement），
 * 放在 canvas shared 层供各节点的处理函数复用同一实现。
 */
import { App } from "antd";
import type { TFunction } from "i18next";

type NotificationApi = ReturnType<typeof App.useApp>["notification"];

/** busy 拒绝提示：面板保持打开、选区原样保留可重试时的唯一反馈。
    key 按节点区分（antd 的 key 全局生效）：同节点连点去重替换，跨节点互不顶替 */
export function notifyNodeBusy(
  notification: NotificationApi,
  t: TFunction,
  nodeId: string,
): void {
  notification.error({
    title: t("clip.busy"),
    placement: "bottomRight",
    key: `clip-busy-${nodeId}`,
  });
}

/** 操作失败提示：后端按错误码给出确定结论时优先用其本地化文案
    （error.<code>，带 fallbackKey 兜底），否则直接回落 fallbackKey。
    key 按节点区分（与 notifyNodeBusy 同款）：同节点重试去重替换，跨节点互不顶替 */
export function notifyActionFailed(
  notification: NotificationApi,
  t: TFunction,
  code: string | undefined,
  fallbackKey: string,
  nodeId: string,
): void {
  const fallback = t(fallbackKey);
  notification.error({
    title: code ? t(`error.${code}`, { defaultValue: fallback }) : fallback,
    placement: "bottomRight",
    key: `clip-failed-${nodeId}`,
  });
}
