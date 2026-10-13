/**
 * 派生产物（缩略图、视频海报、雪碧图、预览代理）的惰性生成：产物已存在则直接复用；
 * 否则同一产物的并发请求合并为一次生成，经 localStorage.writeAtomic 写临时文件后原子落盘。
 * 有效产物 = 非空文件：生成出空文件（如 ffmpeg 无输出却正常退出）按生成失败处理、不发布，
 * 命中判定与之同一规则。
 */

import fs from "fs/promises";
import { localStorage } from "./backends/local";
import { runSingleFlight } from "./media-singleflight";

async function isPublished(key: string): Promise<boolean> {
  const stat = await localStorage.stat(key);
  return stat !== null && stat.size > 0;
}

interface EnsureArtifactOptions {
  /** 产物存储键（如 `_cache/480/...webp`），同时作为合并键 */
  key: string;
  /** 本次请求的取消信号：只退出等待，全部等待者都取消才会取消生成 */
  signal?: AbortSignal;
  /** 把产物写到 tmpPath；signal 为生成级取消信号 */
  produce: (tmpPath: string, signal: AbortSignal) => Promise<void>;
}

export async function ensureArtifact({ key, signal, produce }: EnsureArtifactOptions): Promise<void> {
  // 命中检查在合并之前：命中不进入在途表
  if (await isPublished(key)) return;

  await runSingleFlight({
    key: `artifact|${key}`,
    signal,
    generate: async (genSignal) => {
      // 入口检查与发起生成之间，上一轮同键生成可能刚好落盘；复核一次避免重复生成
      if (await isPublished(key)) return;
      await localStorage.writeAtomic(key, async (tmpPath) => {
        await produce(tmpPath, genSignal);
        const output = await fs.stat(tmpPath).catch(() => null);
        if (!output || output.size === 0) throw new Error(`Artifact generation produced no output: ${key}`);
      });
    },
  });
}
