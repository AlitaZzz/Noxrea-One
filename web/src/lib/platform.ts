/**
 * 平台检测与快捷键修饰键展示。
 * 底层按键检测始终双平台兼容（e.ctrlKey || e.metaKey），这里只负责「展示哪个符号」：
 * Apple 平台显示 ⌘，Windows / Linux 显示 Ctrl。
 */

function detectApplePlatform(): boolean {
  // SSR 无 navigator 回退 Ctrl；实际使用点均为交互后渲染的弹窗/菜单，无水合不一致
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export const isApplePlatform = detectApplePlatform();

/** 快捷键主修饰键展示符号：Windows/Linux 为 Ctrl，Apple 为 ⌘ */
export const MOD_KEY = isApplePlatform ? "⌘" : "Ctrl";

/** 把 "Z" / "Shift+Z" 形式的快捷键补上平台主修饰键前缀（⌘+Z / Ctrl+Shift+Z） */
export function modKey(keys: string): string {
  return `${MOD_KEY}+${keys}`;
}
