/**
 * 本地工作区（specs/storage-s3-backend.md 范围：本地工作区模块抽取）。
 *
 * 任何后端下临时区都在本地盘：派生产物生成（ensureArtifact）、媒体编辑请求、
 * S3 下载缓存都先把字节落在 `<root>/_tmp`，成功后再发布到后端。
 * 落盘一律经 writeAtomic：先写 `_tmp` 下的唯一临时文件，再 rename 原子替换就位。
 * - 直接 `writeFile` 最终路径时，中途失败会留下顶着最终文件名、内容却残缺的文件，
 *   而文件名即内容 hash，后续去重会一直命中这份坏数据；
 * - `rename` 只改目录项，不需要获取目标文件的 Windows 句柄，因此目标正被 sharp /
 *   安全软件等外部句柄占用时仍有机会成功，冲突时退避重试；
 * - 临时文件集中在 `_tmp`：进程崩溃 / 强杀留下的残骸由启动时的 clearTmpDir 一次清空。
 *   rename 跨文件系统会失败（EXDEV），因此存储根（含 `_tmp` 与各派生目录）必须同文件系统。
 * root 参数缺省锚定配置的 UPLOAD_DIR；测试注入的 LocalStorageBackend 显式传自身 baseDir。
 */

import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getConfig } from "@server/core/config";
import { isPathWithinBase, resolveFromRoot } from "@server/core/paths";
import { StorageTraversalError } from "./backend";
import { RENAME_RETRIES, rmQuiet, withRetry } from "./fs-utils";

/**
 * 上传文件根目录（由 UPLOAD_DIR 配置项解析，相对路径按项目根锚定）。
 * 每次调用即时解析而非模块加载期固化：测试经 config mock 注入隔离根，
 * 生产环境配置在 bootstrap 早期已加载，行为不变。
 */
export function uploadRoot(): string {
  return resolveFromRoot(getConfig().UPLOAD_DIR);
}

/** 临时文件目录（`<root>/_tmp`） */
export function tmpDir(root: string = uploadRoot()): string {
  return path.join(root, "_tmp");
}

/**
 * 清空临时目录：其中只有进行中的写入，进程重启后全部作废。
 * 只能在启动阶段、HTTP 服务与 Worker 开始写入之前调用，否则会删掉进行中的写入。
 */
export async function clearTmpDir(root: string = uploadRoot()): Promise<void> {
  await fs.rm(tmpDir(root), { recursive: true, force: true });
}

/**
 * 分配一个工作区临时文件路径：`_tmp/<uuid>.<basename>`（保留扩展名，ffmpeg 等
 * 按扩展名选封装格式的写入方直接可用）。文件由调用方创建与清理。
 */
export function allocateTempPath(basename: string, root: string = uploadRoot()): string {
  return path.join(tmpDir(root), `${randomUUID()}.${path.basename(basename)}`);
}

/**
 * 原子落盘到存储根（发布机制归工作区所有；local 后端的 put 即此操作）：
 * write 把内容写到 `_tmp` 下的唯一临时文件（文件名以目标 basename 结尾、扩展名不变，
 * ffmpeg 等按扩展名选封装格式的写入方直接可用），成功后 rename 到 key 对应路径
 * （目标被外部句柄短暂占用时退避重试）；任一步失败都清理临时文件。
 */
export async function writeAtomic(
  root: string,
  key: string,
  write: (tmpPath: string) => Promise<void>,
): Promise<void> {
  const filePath = path.resolve(root, key);
  if (!isPathWithinBase(root, filePath)) {
    throw new StorageTraversalError(key);
  }
  const tmpPath = allocateTempPath(key, root);
  await Promise.all([
    fs.mkdir(tmpDir(root), { recursive: true }),
    fs.mkdir(path.dirname(filePath), { recursive: true }),
  ]);
  try {
    await write(tmpPath);
    await withRetry(() => fs.rename(tmpPath, filePath), { retries: RENAME_RETRIES });
  } catch (err) {
    // 清理失败的残留由下次启动的 clearTmpDir 回收，不能掩盖原始错误
    await rmQuiet(tmpPath);
    throw err;
  }
}
