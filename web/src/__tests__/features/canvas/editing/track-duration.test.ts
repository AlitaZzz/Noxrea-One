/**
 * 轨道时长口径（specs/client-video-editing.md）：雪碧图时长优先；雪碧图失败时
 * 原视频标称值不可信，必须改用代理时长；代理未知时按 0 保持面板禁用。
 */
import { describe, expect, it } from "vitest";

import { resolveTrackDuration } from "@/features/canvas/editing/track-duration";

describe("resolveTrackDuration", () => {
  it("雪碧图就绪时用服务端按可解码内容计算的时长", () => {
    expect(resolveTrackDuration("sprite", 12.5, 9)).toBe(12.5);
  });

  it("雪碧图失败时改用代理的真实时长，不采用浏览器读到的标称值", () => {
    expect(resolveTrackDuration("fallback", 30, 12.5)).toBe(12.5);
  });

  it("雪碧图失败且代理时长未知时按 0 处理，面板保持禁用", () => {
    expect(resolveTrackDuration("fallback", 30, null)).toBe(0);
  });
});
