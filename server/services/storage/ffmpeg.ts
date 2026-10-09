/**
 * ffmpeg 子进程统一执行器。
 *
 * 所有 ffmpeg 调用共用同一套进程生命周期管理：超时兜底 SIGKILL（残留子进程
 * 会一直持有视频文件句柄，Windows 上表现为该文件后续无法被覆盖写入）、客户端
 * 中断（signal）回收、只结算一次。四个入口：
 * - runFfmpeg   ：严格语义，超时 / 中断 / 进程错误一律 reject，产出类调用使用；
 * - probeFfmpeg ：宽松语义，超时不算失败（stderr 已收集的部分仍可用于解析），
 *   探测类调用使用，由调用方根据 killed / spawnFailed 决定兜底值。
 * - runFfprobe ：严格语义，读取有大小上限的 JSON 元数据。
 * - scanFfprobe：流式读取包或帧条目，不累计完整索引。
 */

import path from "path";
import { spawn } from "child_process";
import { JSONParser } from "@streamparser/json";
import { getConfig } from "@server/core/config";
import { resolveFromRoot } from "@server/core/paths";
import { logEvent } from "@server/core/logger/utils";

function resolveMediaToolPath(configDir: string, tool: "ffmpeg" | "ffprobe"): string {
  const dir = path.isAbsolute(configDir)
    ? configDir
    : resolveFromRoot(configDir);
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  return path.join(dir, exe);
}

export interface FfmpegRunOptions {
  signal?: AbortSignal;
  /** 日志 stage 前缀：超时 / spawn 失败记为 `${stage}_timeout` / `${stage}_spawn_failed` */
  stage?: string;
  /** 附带进日志的字段（如 video: basename） */
  logFields?: Record<string, unknown>;
}

const DIAGNOSTIC_TAIL_CHARS = 64 * 1024;
const PROBE_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

interface ProcessOutcome {
  code: number;
  stderr: string;
  stdout: string;
  killed: boolean;
  spawnError?: Error;
}

function executeMediaTool(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions & { stage: string },
  diagnosticLimit?: number,
  tool: "ffmpeg" | "ffprobe" = "ffmpeg",
  consumeOutput?: (chunk: Buffer) => void,
): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const bin = resolveMediaToolPath(getConfig().FFMPEG_PATH, tool);
    const ffmpeg = spawn(bin, args, { stdio: ["ignore", tool === "ffprobe" ? "pipe" : "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let killed = false;
    let abortError: DOMException | undefined;
    let spawnError: Error | undefined;
    let stdout = "";
    let stdoutBytes = 0;
    let outputError: Error | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    /** 统一收口：只结算一次，并清理定时器与信号监听 */
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      if (settled || killed || abortError) return;
      abortError = new DOMException("Aborted", "AbortError");
      cleanup();
      ffmpeg.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      if (settled || abortError) return;
      killed = true;
      cleanup();
      ffmpeg.kill("SIGKILL");
      logEvent("media", {
        stage: `${opts.stage}_timeout`, timeoutMs, ...opts.logFields,
      });
    }, timeoutMs);

    ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (diagnosticLimit) stderr = stderr.slice(-diagnosticLimit);
    });
    ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      if (outputError || abortError || killed) return;
      try {
        if (consumeOutput) consumeOutput(chunk);
        else {
          stdoutBytes += chunk.length;
          if (stdoutBytes > PROBE_OUTPUT_LIMIT_BYTES) throw new Error("ffprobe output exceeded the 16 MiB metadata budget");
          stdout += chunk.toString();
        }
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
        clearTimeout(timer);
        ffmpeg.kill("SIGKILL");
      }
    });

    // close follows stdio closure: callers can now remove temporary files safely on Windows.
    ffmpeg.on("close", (code) => settle(() => {
      if (abortError) reject(abortError);
      else if (outputError) reject(outputError);
      else resolve({ code: code ?? -1, stderr, stdout, killed, spawnError });
    }));

    ffmpeg.on("error", (err) => {
      spawnError = err;
      if (abortError) return;
      logEvent("media", {
        stage: `${opts.stage}_spawn_failed`,
        error: err.message,
        ffmpegBin: bin,
        ...opts.logFields,
      });
    });

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
  });
}

export async function runFfmpeg(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions = {},
): Promise<{ code: number; stderr: string }> {
  const outcome = await executeMediaTool(args, timeoutMs, { ...opts, stage: opts.stage ?? "ffmpeg" }, DIAGNOSTIC_TAIL_CHARS);
  if (outcome.killed) throw new Error(`ffmpeg timed out after ${timeoutMs}ms`);
  if (outcome.spawnError) throw outcome.spawnError;
  return { code: outcome.code, stderr: outcome.stderr };
}

export interface FfmpegProbeOutcome {
  stderr: string;
  /** 超时被 SIGKILL：stderr 覆盖范围不完整，调用方不得当作完整结果解析 */
  killed: boolean;
  /** 进程未能启动（如 ffmpeg 缺失） */
  spawnFailed: boolean;
}

export async function probeFfmpeg(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions = {}
): Promise<FfmpegProbeOutcome> {
  const outcome = await executeMediaTool(args, timeoutMs, { ...opts, stage: opts.stage ?? "ffmpeg_probe" });
  return { stderr: outcome.stderr, killed: outcome.killed, spawnFailed: !!outcome.spawnError };
}

export async function runFfprobe(args: string[], timeoutMs: number, opts: FfmpegRunOptions = {}): Promise<unknown> {
  const outcome = await executeMediaTool(args, timeoutMs, { ...opts, stage: opts.stage ?? "ffprobe" }, DIAGNOSTIC_TAIL_CHARS, "ffprobe");
  assertProbeSuccess(outcome, timeoutMs);
  return JSON.parse(outcome.stdout) as unknown;
}

function assertProbeSuccess(outcome: ProcessOutcome, timeoutMs: number) {
  if (outcome.killed) throw new Error(`ffprobe timed out after ${timeoutMs}ms`);
  if (outcome.spawnError) throw outcome.spawnError;
  if (outcome.code !== 0) throw new Error(`ffprobe exited with code ${outcome.code}: ${outcome.stderr.slice(-200)}`);
}

interface FfprobeScanOptions extends FfmpegRunOptions {
  section: "packets" | "frames";
  onEntry: (value: unknown) => void;
}

/** Emit one structured entry at a time, releasing each parsed sibling immediately. */
export async function scanFfprobe(args: string[], timeoutMs: number, opts: FfprobeScanOptions): Promise<void> {
  const parser = new JSONParser({ paths: [`$.${opts.section}.*`], keepStack: false });
  parser.onValue = ({ value }) => opts.onEntry(value);
  const outcome = await executeMediaTool(args, timeoutMs, { ...opts, stage: opts.stage ?? "ffprobe_scan" }, DIAGNOSTIC_TAIL_CHARS, "ffprobe", (chunk) => parser.write(chunk));
  assertProbeSuccess(outcome, timeoutMs);
  if (!parser.isEnded) parser.end();
}
