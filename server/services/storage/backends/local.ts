/**
 * 本地磁盘存储后端。
 * 基于文件系统实现 StorageBackend，提供上传根目录下的保存与读取。
 *
 * 落盘一律经 writeAtomic：先写 `<baseDir>/_tmp` 下的唯一临时文件，再 rename 原子替换就位。
 * - 直接 `writeFile` 最终路径时，中途失败会留下顶着最终文件名、内容却残缺的文件，
 *   而文件名即内容 hash，后续去重会一直命中这份坏数据；
 * - `rename` 只改目录项，不需要获取目标文件的写句柄，
 *   因此目标正被 sharp / 安全软件等外部句柄占用时仍有机会成功，冲突时退避重试；
 * - 临时文件集中在 `_tmp`：进程崩溃 / 强杀留下的残骸由启动时的 clearTmpDir 一次清空，
 *   不会散落在各业务目录里永久占盘。rename 跨文件系统会失败（EXDEV），因此上传根目录
 *   （含 `_tmp` 与各派生目录）必须位于同一文件系统。
 */

import fs from "fs/promises";
import path from "path";
import { createReadStream, createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { getConfig } from "@server/core/config";
import { isPathWithinBase, resolveFromRoot } from "@server/core/paths";
import { isTransientFileError, withRetry } from "@server/services/storage/fs-utils";
import type { StorageBackend } from "@server/services/storage/backend";

/** 上传文件根目录（由 UPLOAD_DIR 配置项解析，相对路径按项目根锚定） */
const UPLOAD_DIR = resolveFromRoot(getConfig().UPLOAD_DIR);

/** rename 冲突重试次数（配合 50ms 起退避，累计约 1.5s，覆盖外部句柄的短暂占用） */
const REPLACE_RETRIES = 5;

export class LocalStorageBackend implements StorageBackend {
  /** 对外暴露，供 media.ts 等模块获取正确的 uploads 路径 */
  readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? UPLOAD_DIR;
  }

  private ensureDir(dir: string): Promise<void> {
    return fs.mkdir(dir, { recursive: true }).then(() => {});
  }

  private resolveKey(key: string): string {
    const resolved = path.resolve(path.join(this.baseDir, key));
    if (!isPathWithinBase(this.baseDir, resolved)) {
      throw new Error(`Path traversal detected: ${key}`);
    }
    return resolved;
  }

  /** 临时文件目录（见文件头说明） */
  get tmpDir(): string {
    return path.join(this.baseDir, "_tmp");
  }

  /**
   * 清空临时目录：其中只有进行中的写入，进程重启后全部作废。
   * 只能在启动阶段、HTTP 服务与 Worker 开始写入之前调用，否则会删掉进行中的写入。
   */
  async clearTmpDir(): Promise<void> {
    await fs.rm(this.tmpDir, { recursive: true, force: true });
  }

  /**
   * 原子落盘：write 把内容写到 `_tmp` 下的唯一临时文件（文件名以目标 basename 结尾、扩展名不变，
   * ffmpeg 等按扩展名选封装格式的写入方可直接使用），成功后 rename 到 key 对应路径
   * （目标被外部句柄短暂占用时退避重试）；任一步失败都清理临时文件。
   */
  async writeAtomic(key: string, write: (tmpPath: string) => Promise<void>): Promise<void> {
    const filePath = this.resolveKey(key);
    const tmpPath = path.join(this.tmpDir, `${randomUUID()}.${path.basename(filePath)}`);
    await Promise.all([this.ensureDir(this.tmpDir), this.ensureDir(path.dirname(filePath))]);
    try {
      await write(tmpPath);
      await withRetry(() => fs.rename(tmpPath, filePath), { retries: REPLACE_RETRIES });
    } catch (err) {
      // 清理失败的残留由下次启动的 clearTmpDir 回收，不能掩盖原始错误
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * 保存文件：经 writeAtomic 原子落盘。
   *
   * 内容寻址（key 即内容 hash）语义：目标已存在且大小一致 ⇒ 内容必然一致，
   * 跳过写盘直接视为成功（幂等 PUT）。任一步失败都会清理临时文件，
   * 不会在 uploads 里留下半截文件。
   */
  async save(key: string, source: string | Buffer | ReadableStream): Promise<void> {
    // 本次内容的期望大小：Buffer 直接取长度，string 路径取源文件大小；
    // ReadableStream 大小未知，去重/幂等降级时只以「目标存在」为准。
    let expectedSize: number | undefined;
    if (Buffer.isBuffer(source)) {
      expectedSize = source.length;
    } else if (typeof source === "string") {
      try {
        expectedSize = (await fs.stat(source)).size;
      } catch {
        expectedSize = undefined; // 源路径不可读时交给后续 copyFile 报错
      }
    }

    // 去重短路：目标已存在且大小一致 ⇒ 内容一致，直接返回。
    const existing = await this.stat(key);
    if (existing && (expectedSize === undefined || existing.size === expectedSize)) {
      return;
    }

    try {
      await this.writeAtomic(key, async (tmpPath) => {
        if (typeof source === "string") {
          await fs.copyFile(source, tmpPath);
        } else if (Buffer.isBuffer(source)) {
          await fs.writeFile(tmpPath, source);
        } else {
          // pipeline 自带背压与错误传播，异常时自动 destroy，不会残留未关闭的 fd
          await pipeline(
            Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]),
            createWriteStream(tmpPath),
          );
        }
      });
    } catch (err) {
      // 覆盖失败：目标可能正被并发写入方的读取/缩略图句柄占用
      // （Windows 上对打开中的文件覆盖报 EPERM）。CAS 下目标存在即内容一致，
      // 若目标已就位且大小一致，按幂等成功处理；否则向上抛。
      if (!isTransientFileError(err)) throw err;
      const after = await this.stat(key);
      if (after && (expectedSize === undefined || after.size === expectedSize)) {
        return;
      }
      throw err;
    }
  }

  /**
   * 读取文件流。
   * 传入 signal 后，客户端断开 / 视频 seek 取消会立即销毁流并释放句柄，
   * 这是 Windows 上避免文件被残留句柄占用的关键。
   */
  async read(key: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    const filePath = this.resolveKey(key);
    return createReadStream(
      filePath,
      signal ? { signal } : undefined,
    ) as unknown as NodeJS.ReadableStream;
  }

  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const filePath = this.resolveKey(key);
    try {
      const st = await fs.stat(filePath);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveKey(key);
    try {
      // 被外部句柄短暂占用时退避重试，避免 GC 因一次瞬时冲突就永久漏删
      await withRetry(() => fs.unlink(filePath), { retries: 3 });
    } catch {
      // 文件不存在（ENOENT）或持续被占用：忽略，后续 GC 会再试
    }
    // 向上清理空目录（不删 baseDir 本身）
    await this.cleanupEmptyDirs(path.dirname(filePath));
    await this.deleteDerivedArtifacts(key);
  }

  /**
   * 删除该源文件的派生产物（缩略图档位、海报母版）：派生路径为
   * `<派生根>/<一个分组段>/<源键去扩展名>.webp`（`_cache/<w>/…`、`_posters/v<版本>/…`），
   * 遍历派生根的分组段按前缀删除即可，无需知道具体档位与版本。
   * 雪碧图 / 代理（_sprite / _proxy）的文件名由源键单向哈希派生、无法反查，由各自的 TTL 清扫兜底。
   */
  private async deleteDerivedArtifacts(key: string): Promise<void> {
    const stem = key.replace(/\.[^.]+$/, "");
    for (const root of ["_cache", "_posters"]) {
      const rootDir = path.join(this.baseDir, root);
      let groups: string[];
      try {
        groups = await fs.readdir(rootDir);
      } catch {
        continue; // 派生根不存在：没有可清理的产物
      }
      for (const group of groups) {
        await fs.rm(path.join(rootDir, group, `${stem}.webp`), { force: true }).catch(() => undefined);
        // 从源键所在目录向上回收空目录（分组段与派生根本身空了也一并删，按需重建）
        await this.cleanupEmptyDirs(path.join(rootDir, group, path.dirname(stem)));
      }
    }
  }

  /** 从 dir 向上逐级删除空目录，直到 baseDir 为止 */
  private async cleanupEmptyDirs(dir: string): Promise<void> {
    if (dir === this.baseDir || dir === path.dirname(this.baseDir)) return;
    try {
      const entries = await fs.readdir(dir);
      if (entries.length > 0) return;
      await fs.rmdir(dir);
      // 递归检查上一级
      await this.cleanupEmptyDirs(path.dirname(dir));
    } catch {
      // 目录不存在或非空，忽略
    }
  }

  /** 返回相对路径（不再使用 network.public_base_url 硬编码） */
  publicUrl(key: string): string {
    return `/api/files/${key}`;
  }
}

export const localStorage = new LocalStorageBackend();
