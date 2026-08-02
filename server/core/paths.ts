// ── 项目根路径解析（兼容 cwd=项目根 与 cwd=web/） ──

import path from "path";
import { existsSync } from "fs";

/**
 * 定位项目根目录：向上查找同时包含 server/ 与 package.json 的祖先目录。
 * 失败时回退到 process.cwd()。
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    if (
      existsSync(path.join(dir, "server")) &&
      existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = path.resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** 将"相对项目根"的路径解析为绝对路径；绝对路径原样返回 */
export function resolveFromRoot(rel: string): string {
  return path.isAbsolute(rel) ? rel : path.resolve(findProjectRoot(), rel);
}
