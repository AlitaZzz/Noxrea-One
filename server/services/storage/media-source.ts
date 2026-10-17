/**
 * 媒体源解析（specs/storage-s3-backend.md 业务规则 8）。
 *
 * 路径型消费方（sharp / ffmpeg / ffprobe）统一经此取输入，不再直连后端实现：
 * - local 后端给文件路径（零成本）；
 * - S3 后端给预签名 GET URL（ffmpeg 原生支持 HTTP 输入，短操作直连），
 *   或先下载到工作区再给路径（重操作：预签名 URL 在作业中途过期、HTTP seek 往返）。
 */

import fs from "fs/promises";
import path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import type { StorageBackend } from "./backend";
import { getStorageBackend } from "./service";
import { allocateTempPath } from "./workspace";
import { rmQuiet, withRetry } from "./fs-utils";

export type MediaSource =
  | { kind: "path"; path: string }
  | { kind: "url"; url: string };

/** 短操作输入（probe、抽帧、单帧处理）：local 给路径，S3 给预签名 GET URL */
export async function resolveMediaSource(key: string): Promise<MediaSource> {
  const backend = getStorageBackend();
  if (backend.presignGet) {
    return { kind: "url", url: await backend.presignGet(key) };
  }
  return { kind: "path", path: requireLocalPath(backend, key) };
}

/** 路径型工具（sharp / ffmpeg / ffprobe）的直接输入串：local 后端给路径，S3 后端给预签名 URL */
export function mediaSourceInput(source: MediaSource): string {
  return source.kind === "path" ? source.path : source.url;
}

/**
 * 重操作输入（重剪辑、转码、crop、抽帧序列）：统一租约出本地文件路径。
 * local 直接给存储路径；S3 先经 get() 拉流下载到工作区临时文件，release 释放。
 * signal 传导给远程下载：客户端断开时中止传输（local 路径不涉及读取，无效果）。
 */
export async function acquireMediaFile(
  key: string,
  signal?: AbortSignal,
): Promise<{ path: string; release: () => Promise<void> }> {
  const backend = getStorageBackend();
  if (!backend.presignGet) {
    return { path: requireLocalPath(backend, key), release: async () => {} };
  }
  const tmpPath = allocateTempPath(key);
  try {
    await fs.mkdir(path.dirname(tmpPath), { recursive: true });
    const stream = await backend.get(key, { signal });
    await pipeline(stream, createWriteStream(tmpPath));
  } catch (err) {
    // 下载失败 / 中止不残留半截文件（启动 clearTmpDir 只是兜底，不替代及时清理）
    await rmQuiet(tmpPath);
    throw err;
  }
  // release 尽力而为：Windows 外部句柄可能让临时文件删除瞬时失败，退避重试后仍失败
  // 也只吞掉——release 在请求 finally 中执行，抛错会把成功响应顶替成 500
  return {
    path: tmpPath,
    release: () =>
      withRetry(() => fs.rm(tmpPath, { force: true }), { retries: 3 }).catch(() => undefined),
  };
}

/** 取本地路径能力；既无预签名也无本地路径能力的后端无法直接供给媒体工具 */
function requireLocalPath(backend: StorageBackend, key: string): string {
  if (!backend.resolveLocalPath) {
    throw new Error(`Backend without presign or local path support cannot serve media source: ${key}`);
  }
  return backend.resolveLocalPath(key);
}
