/**
 * 真 FFmpeg 测试供给（video-frames / media-pool-concurrency 共用）。
 *
 * 目录取 FFMPEG_TEST_DIR（仅测试用变量），缺省仓库 bin/（本地供给，git-ignored）。
 * 刻意不读生产 FFMPEG_PATH：测试不得依赖进程环境的偶然状态——vitest singleFork
 * 共享 worker 的 process.env 是可变共享状态，测试文件在模块求值期读它，取值随
 * 同 worker 先前文件的加载副作用漂移（曾致 video-frames 用例仅在全量跑时执行）。
 * 缺二进制时调用方以 available 整体跳过（与 media-pool 的既有语义一致）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

export const testFfmpegDir = process.env.FFMPEG_TEST_DIR ?? path.resolve(process.cwd(), "bin");
export const testFfmpegBin = path.resolve(testFfmpegDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
export const testFfprobeBin = path.resolve(testFfmpegDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
export const ffmpegAvailable = spawnSync(testFfmpegBin, ["-version"]).status === 0;
