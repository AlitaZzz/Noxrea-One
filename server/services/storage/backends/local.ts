/**
 * 本地磁盘存储后端。
 * 基于文件系统实现 StorageBackend（specs/storage-s3-backend.md 业务规则 3）：
 * put/get/stat/delete/list，发布经工作区 writeAtomic 原子落盘；
 * 派生产物清理经 list 按 stem 枚举（与 S3 后端同一接口语义）。
 */

import fs from "fs/promises";
import path from "path";
import { createReadStream, createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { isPathWithinBase } from "@server/core/paths";
import { isTransientFileError, RENAME_RETRIES, withRetry } from "@server/services/storage/fs-utils";
import { listDerivedArtifactKeys, StorageTraversalError, type StorageBackend } from "@server/services/storage/backend";
import { uploadRoot, tmpDir, writeAtomic } from "@server/services/storage/workspace";

export class LocalStorageBackend implements StorageBackend {
  /** 存储根目录（本地实现细节；业务侧经 backend / workspace / 源解析三入口访问，不直连） */
  readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? uploadRoot();
  }

  /** 本地路径能力（接口可选方法 resolveLocalPath 的实现）：存储 key → 绝对路径（穿越守卫） */
  resolveLocalPath(key: string): string {
    // path.resolve 语义：key 以 / 或盘符开头时整体替换 base，视为逃出（与旧路由守卫一致）
    const resolved = path.resolve(this.baseDir, key);
    if (!isPathWithinBase(this.baseDir, resolved)) {
      throw new StorageTraversalError(key);
    }
    return resolved;
  }

  /**
   * 保存文件：经工作区 writeAtomic 原子落盘。
   *
   * 内容寻址（key 即内容 hash）语义：目标已存在且大小一致 ⇒ 内容必然一致，
   * 跳过写盘直接视为成功（幂等 PUT）。任一步失败都会清理临时文件，
   * 不会在 uploads 里留下半截文件。
   *
   * 零拷贝快路径：source 为工作区 `_tmp` 内的文件路径时（派生产物 / 派生落库把产物
   * 直接写进临时区），直接 rename 到目标位——同文件系统内 rename 只改目录项，
   * 不重复搬运字节；rename 持续失败回退通用拷贝流。
   */
  async put(key: string, source: string | Buffer | ReadableStream): Promise<void> {
    // 期望大小：Buffer 直接取长度，string 路径取源文件大小；
    // ReadableStream 大小未知，去重/幂等降级时只以「目标存在」为准。
    let expectedSize: number | undefined;
    if (Buffer.isBuffer(source)) {
      expectedSize = source.length;
    } else if (typeof source === "string") {
      try {
        expectedSize = (await fs.stat(source)).size;
      } catch {
        expectedSize = undefined; // 源路径不可读时交给后续拷贝流报错
      }
    }

    // 去重短路：目标已存在且大小一致 => 内容一致，直接返回。
    const existing = await this.stat(key);
    if (existing && (expectedSize === undefined || existing.size === expectedSize)) {
      return;
    }

    // 零拷贝快路径：源在本后端工作区临时区内且目标不存在 => rename 直接就位（同文件系统原子）。
    // 注意 rename 后源文件不再存在于原路径——临时文件本就是一次性产物，
    // 调用方不得在 put(path) 之后复用该路径（发布即消费）。
    // 快路径命中要求工作区临时路径（allocateTempPath 缺省锚定 uploadRoot）与本后端 baseDir
    // 同根；不一致时静默退化为拷贝流，仅多一次搬运，正确性不受影响。
    if (typeof source === "string" && !existing) {
      const tmpZone = tmpDir(this.baseDir);
      if (source.startsWith(tmpZone + path.sep)) {
        try {
          const target = this.resolveLocalPath(key);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await withRetry(() => fs.rename(source, target), { retries: RENAME_RETRIES });
          return;
        } catch (err) {
          if (!isTransientFileError(err)) throw err;
          // 持续被占用：回退拷贝流再试一轮。只有 rename 未成功才会走到这里，源仍在。
        }
      }
    }

    await writeAtomic(this.baseDir, key, async (tmpPath) => {
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
  }

  /**
   * 读取文件流。
   * 传入 signal 后，客户端断开 / 视频 seek 取消会立即销毁流并释放句柄，
   * 这是 Windows 上避免文件被残留句柄占用的关键。
   * range 供 proxy 分发模式透传（files 路由已按 stat 校验边界后传入）。
   */
  async get(
    key: string,
    opts?: { range?: { start: number; end?: number }; signal?: AbortSignal },
  ): Promise<Readable> {
    const filePath = this.resolveLocalPath(key);
    return createReadStream(filePath, {
      ...(opts?.range ? { start: opts.range.start, end: opts.range.end } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const filePath = this.resolveLocalPath(key);
    try {
      const st = await fs.stat(filePath);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.deleteFileOnly(key);
    // 向上清理空目录（不删存储根本身）
    await this.cleanupEmptyDirs(path.dirname(this.resolveLocalPath(key)));
    await this.deleteDerivedArtifacts(key);
  }

  /**
   * 删除该源文件的派生产物（specs/storage-s3-backend.md 规则 9：delete 负责 key 的一切）。
   * 经 list 枚举 `_cache` / `_posters` 派生根，按 stem 后缀匹配逐个删除——
   * 派生路径为 `<派生根>/<分组段>/<源键去扩展名>.webp`（`_cache/<w>/…`、`_posters/v<版本>/…`）。
   * 雪碧图 / 代理（_sprite / _proxy）的文件名由源键单向哈希派生、无法反查，由各自 TTL 清扫兜底。
   */
  private async deleteDerivedArtifacts(key: string): Promise<void> {
    // 枚举半边是接口级规则，共享实现见 listDerivedArtifactKeys；删除力学（含空目录回收）本地自理
    for (const derived of await listDerivedArtifactKeys(this, key)) {
      await this.deleteFileOnly(derived);
      // 向上回收该派生文件留下的空目录（档位目录、版本目录等）
      await this.cleanupEmptyDirs(path.dirname(this.resolveLocalPath(derived)));
    }
    for (const root of ["_cache", "_posters"]) {
      await this.cleanupEmptyDirs(path.join(this.baseDir, root));
    }
  }

  /** 仅删除对象本体（不触发派生联动）：delete 主体与派生枚举删除共用 */
  private async deleteFileOnly(key: string): Promise<void> {
    const filePath = this.resolveLocalPath(key);
    try {
      await withRetry(() => fs.unlink(filePath), { retries: 3 });
    } catch {
      // 不存在或被占用：忽略
    }
  }

  /**
   * 按前缀枚举对象（相对 posix key + size + 修改时间）；`_tmp` 工作区不在对象命名空间，排除。
   * 遍历根收窄：key 为相对 posix 路径，命中 `xxx/` 前缀的对象必在首段子目录下
   * （如 `_cache/` → `<baseDir>/_cache`），派生清理 / TTL 清扫不再全树遍历；
   * 无 `/` 的前缀保持全树遍历。
   */
  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModifiedMs: number }>> {
    const out: Array<{ key: string; size: number; lastModifiedMs: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // 目录不存在：没有可枚举对象
      }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (full === tmpDir(this.baseDir)) continue; // 本后端工作区临时区不是对象
          await walk(full);
          continue;
        }
        const key = path.relative(this.baseDir, full).split(path.sep).join("/");
        if (!key.startsWith(prefix)) continue;
        const st = await fs.stat(full).catch(() => null);
        if (st) out.push({ key, size: st.size, lastModifiedMs: st.mtimeMs });
      }
    };
    // 首段收窄遍历根（见方法注释）；无 `/` 的前缀从存储根整树遍历
    await walk(prefix.includes("/") ? path.join(this.baseDir, prefix.split("/", 1)[0]) : this.baseDir);
    return out;
  }

  /** 从 dir 向上逐级删除空目录，直到存储根为止 */
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
}
