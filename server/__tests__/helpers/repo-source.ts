/**
 * 架构边界测试共用的源码树工具（`server/__tests__/architecture/*`）。
 * 仓库根定位、目录排除与 TS 源文件枚举只保留这一份实现，避免多个守卫各自维护。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 目录级排除：测试、生成代码与依赖 */
export const EXCLUDED_DIRS = new Set(["__tests__", "generated", "node_modules"]);

/** 递归枚举 `.ts` / `.tsx` / `.mts`（含 `.d.ts`），跳过排除目录；目录不存在时为空 */
export function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

/** 在临时根下按相对路径写入测试源码树（架构检查器负例共用） */
export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const abs = path.join(root, relative);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

/** 仓库根相对路径（统一 `/` 分隔，跨平台稳定） */
export function toRepoPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}
