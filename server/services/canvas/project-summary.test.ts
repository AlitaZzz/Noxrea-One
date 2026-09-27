/**
 * 项目列表摘要投影测试。
 * 覆盖：封面优先级（coverUrl > 首个 image-node src > null）、节点计数、
 * canvasData 损坏时降级为空摘要（列表不因单个项目脏数据整体失败）。
 */
import { describe, expect, it } from "vitest";

import { toProjectSummary, type ProjectSummaryRow } from "./project-summary";

const row = (overrides: Partial<ProjectSummaryRow> = {}): ProjectSummaryRow => ({
  id: "p1",
  name: "A",
  revision: 1,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  coverUrl: null,
  canvasData: "{}",
  ...overrides,
});

describe("toProjectSummary", () => {
  it("无封面时取首个带 src 的 image-node 作为缩略图", () => {
    const summary = toProjectSummary(row({
      canvasData: JSON.stringify({
        nodes: [
          { type: "text-node", data: {} },
          { type: "image-node", data: {} },
          { type: "image-node", data: { src: "/api/files/1/aa/a.png" } },
          { type: "image-node", data: { src: "/api/files/1/bb/b.png" } },
        ],
      }),
    }));

    expect(summary.thumbnail).toBe("/api/files/1/aa/a.png");
    expect(summary.nodeCount).toBe(4);
    expect(summary.coverUrl).toBeNull();
  });

  it("自定义封面优先于画布首图", () => {
    const summary = toProjectSummary(row({
      coverUrl: "/api/files/1/aa/cover.png",
      canvasData: JSON.stringify({ nodes: [{ type: "image-node", data: { src: "/api/files/1/bb/b.png" } }] }),
    }));

    expect(summary.thumbnail).toBe("/api/files/1/aa/cover.png");
    expect(summary.coverUrl).toBe("/api/files/1/aa/cover.png");
  });

  it("封面与首图皆无时缩略图为 null", () => {
    const summary = toProjectSummary(row({
      canvasData: JSON.stringify({ nodes: [{ type: "text-node", data: {} }] }),
    }));

    expect(summary.thumbnail).toBeNull();
  });

  it("canvasData 解析失败时降级为空摘要", () => {
    const summary = toProjectSummary(row({ canvasData: "not-json" }));

    expect(summary.thumbnail).toBeNull();
    expect(summary.nodeCount).toBe(0);
  });
});
