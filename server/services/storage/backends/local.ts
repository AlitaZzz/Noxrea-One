/**
 * 本地磁盘存储后端。
 * 基于文件系统实现 StorageBackend，提供上传根目录下的保存与读取。
 */

import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";
import { getConfig } from "@server/core/config";
import { resolveFromRoot } from "@server/core/paths";
import type { StorageBackend } from "@server/services/storage/backend";

/** 上传文件根目录（由 UPLOAD_DIR 配置项解析，相对路径按项目根锚定） */
const UPLOAD_DIR = resolveFromRoot(getConfig().UPLOAD_DIR);

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

  async save(key: string, source: string | Buffer | ReadableStream): Promise<void> {
    const filePath = this.resolveKey(key);
    await this.ensureDir(path.dirname(filePath));

    if (typeof source === "string") {
      await fs.copyFile(source, filePath);
    } else if (Buffer.isBuffer(source)) {
      await fs.writeFile(filePath, source);
    } else {
      // ReadableStream → file
      const writeStream = (await import("fs")).createWriteStream(filePath);
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writeStream.write(value);
        }
      } finally {
        writeStream.end();
        await new Promise<void>((resolve, reject) => {
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });
      }
    }
  }

  async read(key: string): Promise<NodeJS.ReadableStream> {
    const filePath = this.resolveKey(key);
    return createReadStream(filePath) as unknown as NodeJS.ReadableStream;
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
      await fs.unlink(filePath);
    } catch {
      // ignore
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
