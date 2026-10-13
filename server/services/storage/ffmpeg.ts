/**
 * ffmpeg 子进程统一执行器。
 *
 * 所有 ffmpeg 调用共用同一套进程生命周期管理：超时兜底 SIGKILL（残留子进程
 * 会一直持有视频文件句柄，Windows 上表现为该文件后续无法被覆盖写入）、客户端
 * 中断（signal）回收、只结算一次。四个产出/探测入口按池固定（specs/media-processing-concurrency.md）：
 * - runFfmpegHeavy   ：严格语义，超时 / 中断 / 进程错误一律 reject，整段解码 / 重编码类使用，
 *   占 ffmpeg 重型池（两级准入，必须带属主 owner）；
 * - runFfmpegLight   ：严格语义同上，单帧、流拷贝类使用，占 ffmpeg 轻型池；
 * - probeFfmpeg      ：宽松语义，超时不算失败（stderr 已收集的部分仍可用于解析），由调用方
 *   根据 killed / spawnFailed 决定兜底值；仅读头部的轻量探测使用，豁免并发池；
 * - probeFfmpegDecode ：宽松语义同 probeFfmpeg，全量解码类探测（如完整性校验）使用，
 *   占 ffmpeg 重型池（必须带属主 owner）。
 * 另有 runFfprobe / scanFfprobe 两个 ffprobe 入口（严格语义读元数据 / 流式扫描），豁免并发池。
 * 占哪个池由入口固定，调用方不能逐次覆盖。
 */

import path from "path";
import { spawn } from "child_process";
import { JSONParser } from "@streamparser/json";
import { AbortError } from "@server/core/abort";
import { getConfig } from "@server/core/config";
import { resolveFromRoot } from "@server/core/paths";
import { logEvent } from "@server/core/logger/utils";
import { acquireHeavySlot, acquireMediaSlot } from "./media-pool";

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

/** 重型入口的选项：两级准入按属主用户取个人名额 */
export interface FfmpegHeavyRunOptions extends FfmpegRunOptions {
  owner: number;
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

/** 各入口固定给出的执行规格与占池方式，不暴露给调用方 */
type ExecSpec =
  | { tool: "ffmpeg" | "ffprobe"; gate: "exempt"; diagnosticLimit?: number; consumeOutput?: (chunk: Buffer) => void }
  | { tool: "ffmpeg"; gate: "ffmpeg_light"; diagnosticLimit?: number; consumeOutput?: (chunk: Buffer) => void }
  | { tool: "ffmpeg"; gate: "ffmpeg_heavy"; owner: number; diagnosticLimit?: number; consumeOutput?: (chunk: Buffer) => void };

async function executeMediaTool(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions & { stage: string },
  spec: ExecSpec,
): Promise<ProcessOutcome> {
  // 受控任务先入池：排队等待不计入超时（计时器在 spawn 之后才启动），
  // 过载拒绝 / 排队中止时子进程尚未启动
  const releaseSlot =
    spec.gate === "ffmpeg_heavy" ? await acquireHeavySlot(spec.owner, opts.signal)
    : spec.gate === "ffmpeg_light" ? await acquireMediaSlot("ffmpeg_light", opts.signal)
    : undefined;
  try {
    return await spawnMediaTool(args, timeoutMs, opts, spec);
  } finally {
    releaseSlot?.();
  }
}

function spawnMediaTool(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions & { stage: string },
  spec: ExecSpec,
): Promise<ProcessOutcome> {
  const { tool, diagnosticLimit, consumeOutput } = spec;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AbortError(opts.signal.reason));
      return;
    }
    const bin = resolveMediaToolPath(getConfig().FFMPEG_PATH, tool);
    const ffmpeg = spawn(bin, args, { stdio: ["ignore", tool === "ffprobe" ? "pipe" : "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let killed = false;
    let cancelled: AbortError | undefined;
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
      if (settled || killed || cancelled) return;
      cancelled = new AbortError(opts.signal?.reason);
      cleanup();
      ffmpeg.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      if (settled || cancelled) return;
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
      if (outputError || cancelled || killed) return;
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
      if (cancelled) reject(cancelled);
      else if (outputError) reject(outputError);
      else resolve({ code: code ?? -1, stderr, stdout, killed, spawnError });
    }));

    ffmpeg.on("error", (err) => {
      spawnError = err;
      if (cancelled) return;
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

/** 重型 ffmpeg（整段解码 / 重编码）：占重型池，两级准入按 owner 取个人名额 */
export async function runFfmpegHeavy(
  args: string[],
  timeoutMs: number,
  opts: FfmpegHeavyRunOptions,
): Promise<{ code: number; stderr: string }> {
  const outcome = await executeMediaTool(
    args,
    timeoutMs,
    { ...opts, stage: opts.stage ?? "ffmpeg" },
    { tool: "ffmpeg", gate: "ffmpeg_heavy", owner: opts.owner, diagnosticLimit: DIAGNOSTIC_TAIL_CHARS },
  );
  if (outcome.killed) throw new Error(`ffmpeg timed out after ${timeoutMs}ms`);
  if (outcome.spawnError) throw outcome.spawnError;
  return { code: outcome.code, stderr: outcome.stderr };
}

/** 轻型 ffmpeg（单帧、流拷贝）：占轻型池，不按用户限额 */
export async function runFfmpegLight(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions = {},
): Promise<{ code: number; stderr: string }> {
  const outcome = await executeMediaTool(
    args,
    timeoutMs,
    { ...opts, stage: opts.stage ?? "ffmpeg" },
    { tool: "ffmpeg", gate: "ffmpeg_light", diagnosticLimit: DIAGNOSTIC_TAIL_CHARS },
  );
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

/** 仅读容器头部的轻量探测（音频时长、视频元数据），豁免并发池 */
export function probeFfmpeg(args: string[], timeoutMs: number, opts: FfmpegRunOptions = {}): Promise<FfmpegProbeOutcome> {
  return runProbe(args, timeoutMs, opts, { tool: "ffmpeg", gate: "exempt" });
}

/** 全量解码类探测（如完整性校验）：与产出类同为重型 CPU 任务，占 ffmpeg 重型池 */
export function probeFfmpegDecode(args: string[], timeoutMs: number, opts: FfmpegHeavyRunOptions): Promise<FfmpegProbeOutcome> {
  return runProbe(args, timeoutMs, opts, { tool: "ffmpeg", gate: "ffmpeg_heavy", owner: opts.owner });
}

async function runProbe(
  args: string[],
  timeoutMs: number,
  opts: FfmpegRunOptions,
  spec: ExecSpec,
): Promise<FfmpegProbeOutcome> {
  const outcome = await executeMediaTool(
    args,
    timeoutMs,
    { ...opts, stage: opts.stage ?? "ffmpeg_probe" },
    spec,
  );
  return { stderr: outcome.stderr, killed: outcome.killed, spawnFailed: !!outcome.spawnError };
}

export async function runFfprobe(args: string[], timeoutMs: number, opts: FfmpegRunOptions = {}): Promise<unknown> {
  const outcome = await executeMediaTool(
    args,
    timeoutMs,
    { ...opts, stage: opts.stage ?? "ffprobe" },
    { tool: "ffprobe", gate: "exempt", diagnosticLimit: DIAGNOSTIC_TAIL_CHARS },
  );
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
  const outcome = await executeMediaTool(
    args,
    timeoutMs,
    { ...opts, stage: opts.stage ?? "ffprobe_scan" },
    { tool: "ffprobe", gate: "exempt", diagnosticLimit: DIAGNOSTIC_TAIL_CHARS, consumeOutput: (chunk) => parser.write(chunk) },
  );
  assertProbeSuccess(outcome, timeoutMs);
  if (!parser.isEnded) parser.end();
}
