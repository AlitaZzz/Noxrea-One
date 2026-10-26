"use client";

import { useCallback, useState } from "react";

/**
 * 与 DOM 元素绑定的状态镜像（播放态、进度、时长等）。
 *
 * 元素换实例后（key 重挂、换源、重新签址），新元素不会补发旧元素的事件：新元素若
 * 暂停在 0 就不会触发 pause，镜像会停在旧值，界面表现为「图标显示暂停、实际在播」。
 * 因此镜像必须按**元素身份**记账：身份一变立即作废、回到初始值。身份要覆盖所有会让
 * 元素换实例的输入（重挂令牌、源地址、会话纪元），由各调用方在调用处拼装。
 *
 * 复位走 React 官方的「渲染期依据 props 调整 state」写法：本轮渲染就返回初始值，
 * 不经过 effect，不存在闪一帧旧值的窗口。
 *
 * `initial` 必须是稳定引用（模块级常量）：它参与 `patch` 的依赖，每次渲染新建对象
 * 会让返回的 `patch` 不断换身份，拖累调用方以它为依赖的 useCallback / effect。
 */
export function useElementMirror<T extends object>(
  identity: string,
  initial: T,
): [T, (next: Partial<T>) => void] {
  const [mirror, setMirror] = useState<{ identity: string; value: T }>({ identity, value: initial });
  if (mirror.identity !== identity) setMirror({ identity, value: initial });
  const current = mirror.identity === identity ? mirror.value : initial;
  const patch = useCallback(
    (next: Partial<T>) => {
      setMirror((prev) => ({
        identity,
        value: { ...(prev.identity === identity ? prev.value : initial), ...next },
      }));
    },
    [identity, initial],
  );
  return [current, patch];
}
