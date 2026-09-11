/**
 * 参考区分组之间的竖线分隔。
 * 参考区按类型分组展示（文本 → 音频 → 图片 → 视频），组间用它分隔，
 * 高度与参考卡片一致（56px）。
 */
"use client";

export default function RefGroupDivider() {
  return (
    <div
      className="w-px h-14 mx-1 shrink-0 self-center"
      style={{ background: "var(--canvas-border)" }}
    />
  );
}
