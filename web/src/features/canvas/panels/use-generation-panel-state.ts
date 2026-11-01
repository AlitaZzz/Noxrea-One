"use client";

import { useEffect, useState } from "react";

/**
 * 生成面板的目标作用域本地状态：提交中标记、参考拖拽态、受控菜单开合。
 *
 * 面板实例由宿主常驻，不能依赖「卸载即清理」：目标切换或隐藏时必须显式复位，
 * 否则重新可见时受控菜单会自行展开、拖拽态残留。同一时机失效在途提交
 * （等价于旧实现的「卸载即取消」，GEN-01）；已绑定到节点的生成任务不受影响，
 * 继续由遮罩与 SSE 监控接管。
 */
export function useGenerationPanelState(
  nodeId: string,
  active: boolean,
  invalidate: () => void,
) {
  const [submitting, setSubmitting] = useState(false);
  const [isRefDragging, setIsRefDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // 目标切换 / 隐藏时在渲染期复位（外部事件驱动）：同步生效，且不产生
  // 「effect 内 setState → 再渲染」的级联提交。
  const [scope, setScope] = useState({ nodeId, active });
  if (scope.nodeId !== nodeId || scope.active !== active) {
    setScope({ nodeId, active });
    setSubmitting(false);
    setIsRefDragging(false);
    setMenuOpen(false);
  }

  // 失效在途提交（等价于「卸载即取消」，GEN-01）。
  useEffect(() => {
    invalidate();
  }, [nodeId, active, invalidate]);

  return { submitting, setSubmitting, isRefDragging, setIsRefDragging, menuOpen, setMenuOpen };
}
