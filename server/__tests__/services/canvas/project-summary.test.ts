/**
 * 项目列表摘要投影测试。
 * 覆盖：保存路径派生（deriveCanvasSummary）、封面优先级（coverUrl > 首图 src > null）、
 * 脏数据降级为空摘要（列表不因单个项目脏数据整体失败）。
 */
import { describe, expect, it } from "vitest";

import { deriveCanvasSummary, toProjectSummary, type ProjectSummaryRow } from "@server/services/canvas/project-summary";

const row = (overrides: Partial<ProjectSummaryRow> = {}): ProjectSummaryRow => ({
  id: "p1",
  name: "A",
  revision: 1,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  coverUrl: null,
  nodeCount: 0,
  thumbnailSrc: null,
  ...overrides,
});

describe("deriveCanvasSummary（保存路径派生）", () => {
  it("统计节点数并取首个带 src 的 image-node", () => {
    const summary = deriveCanvasSummary({
      nodes: [
        { type: "text-node", data: {} },
        { type: "image-node", data: {} },
        { type: "image-node", data: { src: "/api/files/1/aa/a.png" } },
        { type: "image-node", data: { src: "/api/files/1/bb/b.png" } },
      ],
    });

    expect(summary.nodeCount).toBe(4);
    expect(summary.thumbnailSrc).toBe("/api/files/1/aa/a.png");
  });

  it("nodes 缺失或非数组时降级为空摘要", () => {
    expect(deriveCanvasSummary({})).toEqual({ nodeCount: 0, thumbnailSrc: null });
    expect(deriveCanvasSummary({ nodes: "bad" })).toEqual({ nodeCount: 0, thumbnailSrc: null });
    expect(deriveCanvasSummary(null)).toEqual({ nodeCount: 0, thumbnailSrc: null });
  });

  it("无 image-node 时首图为 null", () => {
    expect(deriveCanvasSummary({ nodes: [{ type: "text-node", data: {} }] })).toEqual({
      nodeCount: 1,
      thumbnailSrc: null,
    });
  });
});

describe("toProjectSummary（读取端投影）", () => {
  it("无封面时缩略图取冗余首图列", () => {
    const summary = toProjectSummary(row({ nodeCount: 4, thumbnailSrc: "/api/files/1/aa/a.png" }));

    expect(summary.thumbnail).toBe("/api/files/1/aa/a.png");
    expect(summary.nodeCount).toBe(4);
    expect(summary.coverUrl).toBeNull();
  });

  it("自定义封面优先于画布首图", () => {
    const summary = toProjectSummary(
      row({
        coverUrl: "/api/files/1/aa/cover.png",
        nodeCount: 1,
        thumbnailSrc: "/api/files/1/bb/b.png",
      }),
    );

    expect(summary.thumbnail).toBe("/api/files/1/aa/cover.png");
    expect(summary.coverUrl).toBe("/api/files/1/aa/cover.png");
  });

  it("封面与首图皆无时缩略图为 null", () => {
    expect(toProjectSummary(row()).thumbnail).toBeNull();
  });
});
