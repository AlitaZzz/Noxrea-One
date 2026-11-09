/**
 * 架构测试共享的源码扫描工具：目录遍历与静态模块说明符提取。
 * 只服务于测试，不进入运行时包。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const EXCLUDED_DIRS = new Set(["node_modules", ".next"]);

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** 递归收集目录下的 TypeScript 源文件；目录不存在时返回空数组。 */
export function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (EXCLUDED_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * 静态 import / re-export / import type 的模块说明符。
 * 动态 `import()` 与 `require()` 不在 TypeScript 预处理的导入清单里，
 * 需要覆盖这些形态的扫描器自行走 AST。
 */
export function importedSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return ts.preProcessFile(source, true, true).importedFiles.map((entry) => entry.fileName);
}
