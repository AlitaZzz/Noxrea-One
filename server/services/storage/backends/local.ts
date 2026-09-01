/**
 * 本地磁盘存储后端。
 * 基于文件系统实现 StorageBackend，提供上传根目录下的保存与读取。
 *
 * 落盘一律采用「同目录临时文件 + rename 原子替换」：
 * - 直接 `writeFile` 最终路径时，中途失败会留下顶着最终文件名、内容却残缺的文件，
 *   而文件名即内容 hash，后续去重会一直命中这份坏数据；
 * - `rename` 只改目录项，不需要获取目标文件的写句柄，
 *   因此目标正被 sharp / 安全软件等外部句柄占用时仍有机会成功，冲突时退避重试。
 */

import fs from "fs/promises";
import path from "path";
import { createReadStream, createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { getConfig } from "@server/core/config";
import { resolveFromRoot } from "@server/core/paths";
import { withRetry } from "@server/services/storage/fs-utils";
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
    // 路径穿越防护
    if (!resolved.startsWith(this.baseDir)) {
      throw new Error(`Path traversal detected: ${key}`);
    }
    return resolved;
  }

  /**
   * 保存文件：先写同目录临时文件，再原子替换就位。
   * 任一步失败都会清理临时文件，不会在 uploads 里留下 .tmp 垃圾或半截文件。
   */
  async save(key: string, source: string | Buffer | ReadableStream): Promise<void> {
    const filePath = this.resolveKey(key);
    await this.ensureDir(path.dirname(filePath));

    // 与最终文件同目录，确保 rename 落在同一分区（跨分区 rename 不具备原子性）
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
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

      await withRetry(() => fs.rename(tmpPath, filePath), {
        retries: REPLACE_RETRIES,
      });
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
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

  /** 返回相对路径（不再使用 PUBLIC_URL 硬编码） */
  publicUrl(key: string): string {
    return `/api/files/${key}`;
  }
}

export const localStorage = new LocalStorageBackend();
