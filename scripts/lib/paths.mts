/**
 * 脚本共用的仓库路径。
 * 按模块文件位置解析，不依赖调用方的 cwd。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
