/**
 * 画布图片 LOD 取档策略（specs/canvas-media-resolution-lod.md 规则 3/4/5）。
 * 纯函数验证：目标像素 → 档位、自然宽度上限、contain 宽度、滞回。
 */
import { describe, expect, it } from "vitest";

import {
  chooseLodLevel,
  imageLoadWeight,
  inFlightWidth,
  isLodEligibleImageUrl,
  levelWidth,
  lodCssWidth,
  nextLodLevel,
  ORIGINAL_LEVEL,
} from "@/features/canvas/shared/image-lod";

describe("档位纯函数（specs/canvas-media-resolution-lod.md 规则 3/4/5）", () => {
  it("目标像素：600 px 节点在 0.1/1/2.5 缩放与 DPR 1/2/3 下取规范档位", () => {
    expect(chooseLodLevel(600 * 0.1 * 1)).toBe(64);
    expect(chooseLodLevel(600 * 0.1 * 2)).toBe(200);
    expect(chooseLodLevel(600 * 1 * 1)).toBe(640);
    expect(chooseLodLevel(600 * 1 * 2)).toBe(1280);
    expect(chooseLodLevel(600 * 2.5 * 1)).toBe(1920);
    // 目标 4500 px 超过最大档位 2560：回退原图
    expect(chooseLodLevel(600 * 2.5 * 3)).toBe(ORIGINAL_LEVEL);
  });

  it("超过最大档位或达到自然宽度时回退原图，取档不超过自然宽度时用档位", () => {
    expect(chooseLodLevel(2560)).toBe(2560);
    expect(chooseLodLevel(2561)).toBe(ORIGINAL_LEVEL);
    // 取档 640 大于自然宽度 500：请求派生档位只会放大，改用原图
    expect(chooseLodLevel(600, 500)).toBe(ORIGINAL_LEVEL);
    expect(chooseLodLevel(400, 400)).toBe(ORIGINAL_LEVEL);
    expect(chooseLodLevel(300, 400)).toBe(300);
    // 两档之间向上取整；该档位仍不超过自然宽度
    expect(chooseLodLevel(310, 400)).toBe(320);
    expect(chooseLodLevel(600, 2000)).toBe(640);
  });

  it("contain 后的实际显示宽度按已知宽高比收窄", () => {
    expect(lodCssWidth(600, 300, 2)).toBe(600);
    expect(lodCssWidth(600, 300, 1)).toBe(300);
    expect(lodCssWidth(600, 300)).toBe(600);
    expect(lodCssWidth(0, 300, 2)).toBe(0);
  });

  it("等级宽度：原图按自然宽度，未知时视为最大档位（滞回需要有限值）", () => {
    expect(levelWidth(ORIGINAL_LEVEL, 2000)).toBe(2000);
    expect(levelWidth(ORIGINAL_LEVEL)).toBe(2560);
    expect(levelWidth(640, 2000)).toBe(640);
  });

  it("在途宽度：原图自然宽度未知时视为高于最大档位（规则 3.9 的缩小中止）", () => {
    expect(inFlightWidth(ORIGINAL_LEVEL, 2000)).toBe(2000);
    // 与 levelWidth 的差别只在未知分支：中止判定必须把原图视为更高，
    // 否则目标恰好是最大档的缩小手势会漏掉中止，在途原图继续解码
    expect(inFlightWidth(ORIGINAL_LEVEL)).toBe(Number.POSITIVE_INFINITY);
    expect(levelWidth(ORIGINAL_LEVEL)).toBe(2560);
    expect(inFlightWidth(640, 2000)).toBe(640);
  });

  it("升级立即生效；降档仅在目标低于当前宽度 75% 时生效", () => {
    expect(nextLodLevel(null, 60, 64)).toBe(64);
    expect(nextLodLevel(64, 600, 640)).toBe(640);
    // 边界：目标恰好等于当前宽度的 75%，保留当前档位
    expect(nextLodLevel(1280, 960, 960)).toBe(1280);
    expect(nextLodLevel(1280, 959, 960)).toBe(960);
    // 原图按自然宽度参与滞回：只低 20% 时保留原图
    expect(nextLodLevel(ORIGINAL_LEVEL, 1600, 1920, 2000)).toBe(ORIGINAL_LEVEL);
    expect(nextLodLevel(ORIGINAL_LEVEL, 1400, 1920, 2000)).toBe(1920);
  });
});

describe("LOD 资格与任务重量（specs/canvas-media-resolution-lod.md 规则 2/7）", () => {
  it("只有托管 PNG/JPEG 参与 LOD；GIF/WebP/未知扩展名与外部 URL 不参与", () => {
    expect(isLodEligibleImageUrl("/api/files/1/ab/x.png")).toBe(true);
    expect(isLodEligibleImageUrl("/api/files/1/ab/x.jpg")).toBe(true);
    expect(isLodEligibleImageUrl("/api/files/1/ab/x.JPEG")).toBe(true);
    expect(isLodEligibleImageUrl("/api/files/1/ab/x.gif")).toBe(false);
    expect(isLodEligibleImageUrl("/api/files/1/ab/x.webp")).toBe(false);
    expect(isLodEligibleImageUrl("/api/files/1/ab/noext")).toBe(false);
    expect(isLodEligibleImageUrl("https://cdn.example.com/x.png")).toBe(false);
    expect(isLodEligibleImageUrl("blob:https://example.com/x")).toBe(false);
    expect(isLodEligibleImageUrl("data:image/png;base64,xxx")).toBe(false);
  });

  it("重量：≤1280 档 1、≥1920 档 2、托管原图 3、外部/data/blob 1", () => {
    expect(imageLoadWeight("/api/files/1/ab/x.png?w=200")).toBe(1);
    expect(imageLoadWeight("/api/files/1/ab/x.png?w=1280")).toBe(1);
    expect(imageLoadWeight("/api/files/1/ab/x.png?w=1920")).toBe(2);
    expect(imageLoadWeight("/api/files/1/ab/x.png?w=2560")).toBe(2);
    // 非规范宽度按服务端归一化后的档位计费
    expect(imageLoadWeight("/api/files/1/ab/x.png?w=2048")).toBe(2);
    expect(imageLoadWeight("/api/files/1/ab/x.png")).toBe(3);
    expect(imageLoadWeight("/api/files/1/ab/x.png?w=0")).toBe(3);
    expect(imageLoadWeight("https://cdn.example.com/x.png?w=2560")).toBe(1);
    expect(imageLoadWeight("blob:preview")).toBe(1);
    expect(imageLoadWeight("data:image/png;base64,xxx")).toBe(1);
  });
});
