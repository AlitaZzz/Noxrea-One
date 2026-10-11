import { useCallback } from "react";

/**
 * 浮层（DropdownMenu / Popover）关闭后焦点还原到触发器时的焦点环策略。
 *
 * 背景：Radix 在浮层卸载时通过脚本把焦点还原到触发器。浏览器对"脚本焦点
 * 是否显示 :focus-visible"采用文档级输入模态启发式（键盘 / 鼠标），而该模态
 * 只在 pointerdown 实际移动焦点时才会切到鼠标；全新加载的文档（例如刷新后
 * 首次操作）会被误判为键盘模态，导致鼠标操作关闭菜单后触发器也显示焦点环。
 *
 * 策略：应用侧自行追踪最近输入模态；指针模态下关闭浮层时给触发器打上
 * `data-focus-ring-suppressed`，由样式层抑制焦点环。键盘模态不做处理，
 * 保持浏览器默认行为（键盘操作显示焦点环）。
 */

export type InputModality = "keyboard" | "pointer";

const SUPPRESSED_ATTR = "data-focus-ring-suppressed";

let lastModality: InputModality = "keyboard";
let trackingInstalled = false;

function ensureModalityTracking(): void {
  if (trackingInstalled || typeof window === "undefined") return;
  trackingInstalled = true;
  window.addEventListener(
    "keydown",
    () => {
      lastModality = "keyboard";
    },
    { capture: true },
  );
  window.addEventListener(
    "pointerdown",
    () => {
      lastModality = "pointer";
    },
    { capture: true },
  );
}

export function getLastInputModality(): InputModality {
  return lastModality;
}

// 必须在模块加载时即开始追踪：抑制判断发生在菜单关闭时，若此时才安装
// 监听器，此前的 pointerdown 全部丢失，模态会停留在默认的 keyboard。
ensureModalityTracking();

// 浮层内容元素 → 触发器元素。两者只在浮层打开期间存在 aria 关联
// （触发器 aria-controls / 内容 aria-labelledby），内容卸载后关联即消失，
// 因此必须在打开时登记，关闭时凭 WeakMap 反查。
const anchors = new WeakMap<Element, Element>();

function findAnchorTrigger(content: Element): Element | null {
  const labelledby = content.getAttribute("aria-labelledby");
  if (labelledby) {
    const trigger = document.getElementById(labelledby);
    if (trigger) return trigger;
  }
  if (!content.id) return null;
  // useId 可能包含特殊字符，属性选择器加引号并转义双引号即可
  const escaped = content.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return document.querySelector(`[aria-controls="${escaped}"]`);
}

/**
 * 在浮层内容挂载（ref attach）时登记其触发器。
 * 注意：必须在 ref 回调里调用而不是挂载 effect——Radix Portal 首次渲染
 * 返回 null，内容在下一轮 commit 才挂载，effect 跑在 ref attach 之前。
 */
export function registerFocusRingAnchor(content: Element): void {
  const trigger = findAnchorTrigger(content);
  if (trigger) anchors.set(content, trigger);
}



/**
 * 共享 DropdownMenuContent / PopoverContent 的焦点环抑制接线。
 * 两处封装的 ref 登记 + onCloseAutoFocus 仲裁逻辑完全相同，集中在此。
 * ref 回调负责登记锚点（detach 时不注销：Radix 的 onCloseAutoFocus 在
 * 卸载后的 setTimeout(0) 才触发，锚点必须留到那时；WeakMap 随元素 GC 清理）。
 */
export function useContentFocusRingAnchor(restoreFocus: boolean) {
  const handleContentRef = useCallback((node: HTMLDivElement | null) => {
    if (node) registerFocusRingAnchor(node);
  }, []);
  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      if (!restoreFocus) {
        event.preventDefault();
        return;
      }
      // 焦点即将被脚本还原到触发器：指针模态下抑制焦点环
      suppressFocusRingForContent(event.currentTarget as Element);
    },
    [restoreFocus],
  );
  return { handleContentRef, handleCloseAutoFocus };
}

/**
 * 浮层经指针交互关闭、焦点即将被脚本还原到触发器时调用。
 * 给触发器打抑制标记；焦点离开或下一次任意输入时移除。
 */
export function suppressFocusRingForContent(content: Element): void {
  if (getLastInputModality() !== "pointer") return;
  const trigger = anchors.get(content);
  if (!trigger) return;
  trigger.setAttribute(SUPPRESSED_ATTR, "");
  const controller = new AbortController();
  const clear = () => {
    trigger.removeAttribute(SUPPRESSED_ATTR);
    controller.abort();
  };
  trigger.addEventListener("focusout", clear, { once: true, signal: controller.signal });
  window.addEventListener("pointerdown", clear, { capture: true, signal: controller.signal });
  window.addEventListener("keydown", clear, { capture: true, signal: controller.signal });
}
