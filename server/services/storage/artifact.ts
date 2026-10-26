/**
 * 派生产物（缩略图、视频海报、雪碧图、预览代理）的惰性生成（specs/storage-s3-backend.md 规则 7）：
 * 产物已存在（stat 命中）则直接复用；否则同一产物的并发请求合并为一次生成，
 * 写入本地工作区临时文件后经后端 put 发布（local 为零拷贝 rename，S3 为上传）。
 * 有效产物 = 非空文件：生成出空文件（如 ffmpeg 无输出却正常退出）按生成失败处理、不发布，
 * 命中判定与之同一规则。
 */

import fs from "fs/promises";
import { rmQuiet } from "./fs-utils";
import { derivedTierOf } from "./derived-keys";
import { MediaPoolBusyError } from "./media-pool";
import { getStorageBackend } from "./service";
import { allocateTempPath, tmpDir } from "./workspace";
import { runSingleFlight } from "@server/core/single-flight";
import { metrics } from "@server/core/metrics";

/**
 * 「按设计不生成」的哨兵基类：生产者用它表达这类输入本就没有派生产物
 * （例如 APNG 退回原图）。它穿过本模块时记 `skipped` 而不是 `failed`——
 * 失败率只应反映真实故障，否则每次请求这类内容都会污染告警口径。
 */
export class ArtifactSkipError extends Error {}

/** 取消不是生成故障：中止来源可能是 core AbortError 或运行时的 DOMException */
function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function isPublished(key: string): Promise<boolean> {
  const stat = await getStorageBackend().stat(key);
  return stat !== null && stat.size > 0;
}

interface EnsureArtifactOptions {
  /** 派生产物存储键（`_cache`/`_posters`/`_sprite`/`_proxy` 之一），同时作为合并键 */
  key: string;
  /** 本次请求的取消信号：只退出等待，全部等待者都取消才会取消生成 */
  signal?: AbortSignal;
  /** 把产物写到 tmpPath；signal 为生成级取消信号 */
  produce: (tmpPath: string, signal: AbortSignal) => Promise<void>;
}

export async function ensureArtifact({ key, signal, produce }: EnsureArtifactOptions): Promise<void> {
  // 指标档位与 key 的命名空间同址推导（derived-keys 是所有派生 key 的构造方）：
  // 调用点手写标签会与实际写入的命名空间各自漂移，且没有类型能发现
  const tier = derivedTierOf(key);
  if (!tier) throw new Error(`ensureArtifact only serves derived namespaces: ${key}`);

  // 命中检查在合并之前：命中不进入在途表
  if (await isPublished(key)) {
    metrics.derivedArtifact(tier, "hit");
    return;
  }

  await runSingleFlight({
    key: `artifact|${key}`,
    signal,
    generate: async (genSignal) => {
      // 入口检查与发起生成之间，上一轮同键生成可能刚好落盘；复核一次避免重复生成
      if (await isPublished(key)) {
        metrics.derivedArtifact(tier, "hit");
        return;
      }
      const tmpPath = allocateTempPath(key);
      await fs.mkdir(tmpDir(), { recursive: true });
      try {
        await produce(tmpPath, genSignal);
        const output = await fs.stat(tmpPath).catch(() => null);
        if (!output || output.size === 0) {
          throw new Error(`Artifact generation produced no output: ${key}`);
        }
        await getStorageBackend().put(key, tmpPath);
        metrics.derivedArtifact(tier, "generated");
      } catch (err) {
        if (err instanceof ArtifactSkipError) {
          metrics.derivedArtifact(tier, "skipped");
        } else if (!isCancellation(err) && !(err instanceof MediaPoolBusyError)) {
          // 取消是请求生命周期结束，过载拒绝由 mediaBusyRejected 在分类点单点计数；
          // 两者都不是生成故障，记 failed 会让失败率被用户取消与容量波动放大
          metrics.derivedArtifact(tier, "failed");
        }
        throw err;
      } finally {
        await rmQuiet(tmpPath);
      }
    },
  });
}
