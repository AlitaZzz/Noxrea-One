/**
 * 画布保存分层的文件级不变量（specs/web-module-contracts.md 规则 2）。
 *
 * `canvas-document-store` 是叶子：它不导入保存器，且只允许适配层
 * (`stores/canvas-store.ts`) 与保存器 (`persistence/save-manager.ts`) 导入。
 * 该不变量保证 `canvas-store → save-manager` 的模块求值顺序在任一动作可达前
 * 完成意图订阅；若其它文件绕过适配层直接写文档 store，保存意图可能无人接收。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { importedSpecifiers, sourceFiles, toPosix } from "@/__tests__/test-utils/source-scan";

const CANVAS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../features/canvas",
);

function relativeOf(file: string): string {
  return toPosix(path.relative(CANVAS_ROOT, file));
}

describe("canvas 保存分层", () => {
  it("只允许 canvas-store 与 save-manager 导入文档 store", () => {
    const allowed = new Set([
      "stores/canvas-store.ts",
      "persistence/save-manager.ts",
    ]);
    const offenders = sourceFiles(CANVAS_ROOT).filter((file) => {
      if (allowed.has(relativeOf(file))) return false;
      return importedSpecifiers(file).some((specifier) =>
        specifier.includes("canvas-document-store"),
      );
    });
    expect(offenders.map(relativeOf)).toEqual([]);
  });

  it("文档 store 不导入保存器", () => {
    const store = path.join(CANVAS_ROOT, "stores/canvas-document-store.ts");
    expect(importedSpecifiers(store).filter((specifier) => specifier.includes("save-manager"))).toEqual([]);
  });
});
