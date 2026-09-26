/**
 * ffmpeg 子进程统一执行器。
 *
 * 所有 ffmpeg 调用共用同一套进程生命周期管理：超时兜底 SIGKILL（残留子进程
 * 会一直持有视频文件句柄，Windows 上表现为该文件后续无法被覆盖写入）、客户端
 * 中断（signal）回收、只结算一次。两个变体：
 * - runFfmpeg   ：严格语义，超时 / 中断 / 进程错误一律 reject，产出类调用使用；
 * - probeFfmpeg ：宽松语义，超时不算失败（stderr 已收集的部分仍可用于解析），
 *   探测类调用使用，由调用方根据 killed / spawnFailed 决定兜底值。
 */

import path from "path";
import { spawn } from "child_process";
import { getConfig } from "@server/core/config";
import { resolveFromRoot } from "@server/core/paths";
import { logEvent } from "@server/core/logger/utils";

/** 解析 ffmpeg 可执行文件路径：FFMPEG_PATH 为目录，根据 OS 拼接 ffmpeg / ffmpeg.exe */
export function resolveFfmpegPath(configDir: string): string {
  const dir = path.isAbsolute(configDir)
    ? configDir
    : resolveFromRoot(configDir);
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(dir, exe);
}

export interface FfmpegRunOptions {
  signal?: AbortSignal;
  /** 日志 stage 前缀：超时 / spawn 失败记为 `${stage}_timeout` / `${stage}_spawn_failed` */
  stage?: string;
  /** 附带进日志的字段（如 video: basename） */
  logFields?: Record<string, unknown>;
}

function ffmpegBin(): string {
  const bin = resolveFfmpegPath(getConfig().FFMPEG_PATH);
  return bin;
}

export function runFfmpeg(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions = {}
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const bin = ffmpegBin();
    const ffmpeg = spawn(bin, args);
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      logEvent("media", {
        stage: `${opts.stage ?? "ffmpeg"}_timeout`,
        timeoutMs,
        ...opts.logFields,
      });
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    /** 统一收口：只结算一次，并清理定时器与信号监听 */
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      ffmpeg.kill("SIGKILL");
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    };
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return; }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("close", (code) => settle(() => resolve({ code: code ?? -1, stderr })));

    ffmpeg.on("error", (err) => {
      logEvent("media", {
        stage: `${opts.stage ?? "ffmpeg"}_spawn_failed`,
        error: err.message,
        ffmpegBin: bin,
        ...opts.logFields,
      });
      settle(() => reject(err));
    });
  });
}

export interface FfmpegProbeOutcome {
  stderr: string;
  /** 超时被 SIGKILL：stderr 覆盖范围不完整，调用方不得当作完整结果解析 */
  killed: boolean;
  /** 进程未能启动（如 ffmpeg 缺失） */
  spawnFailed: boolean;
}

export function probeFfmpeg(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions = {}
): Promise<FfmpegProbeOutcome> {
  return new Promise((resolve) => {
    const bin = ffmpegBin();
    const ffmpeg = spawn(bin, args);
    let stderr = "";
    let settled = false;

    const settle = (outcome: Partial<FfmpegProbeOutcome>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stderr, killed: false, spawnFailed: false, ...outcome });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      logEvent("media", {
        stage: `${opts.stage ?? "ffmpeg_probe"}_timeout`,
        timeoutMs,
        ...opts.logFields,
      });
      settle({ killed: true });
    }, timeoutMs);

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("close", () => settle({}));

    ffmpeg.on("error", (err) => {
      logEvent("media", {
        stage: `${opts.stage ?? "ffmpeg_probe"}_spawn_failed`,
        error: err.message,
        ffmpegBin: bin,
        ...opts.logFields,
      });
      settle({ spawnFailed: true });
    });
  });
}
