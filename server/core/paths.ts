/**
 * 项目根路径解析。
 * 兼容 cwd 为项目根与 cwd 为 web/ 两种启动方式，
 * 向上查找同时包含 server/ 与 package.json 的祖先目录作为根。
 */

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

/**
 * 路径穿越守卫：target 解析后的绝对路径是否位于 baseDir（或其子目录）内。
 * 全仓唯一的路径包含判定入口——startsWith 前缀比对会被兄弟目录绕过
 * （baseDir ".../storage/files" 恰是 ".../storage/filesPrivate" 的前缀），
 * 必须用 path.relative 判定。target 等于 baseDir 本身不算在内。
 */
export function isPathWithinBase(baseDir: string, target: string): boolean {
  const rel = path.relative(path.resolve(baseDir), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
