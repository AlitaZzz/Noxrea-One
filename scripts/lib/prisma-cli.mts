/**
 * Prisma 7 CLI 调用单点（迁移脚本与测试 globalSetup 共用）。
 *
 * Prisma 7 CLI 不再自动加载 .env：调用方负责传入含连接串的环境。
 * 本模块只做进程调用，不读取或推断任何数据库配置。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { repoRoot } from "./paths.mts";

const prismaCli = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");

/** 执行 Prisma CLI 并继承 stdio（迁移应用 / 客户端生成）。失败时抛出带子进程退出码的错误。 */
export function runPrisma(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
}

/** 执行 Prisma CLI 并返回 stdout（迁移 SQL 生成）；stderr 留在错误对象中供调用方输出。 */
export function capturePrisma(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 连接串统一脱敏：失败输出可能包含 Prisma 回显的 URL，禁止把凭据打到日志。 */
function redactDatabaseUrls(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "<postgres-url>");
}

/**
 * 脚本入口的统一失败出口：优先输出子进程 stderr（Prisma 的真实错误），
 * 保留其退出码；非进程错误按 1 退出。
 */
export function failWithPrismaError(prefix: string, error: unknown): never {
  const failure = error as { status?: number; stderr?: string };
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const message = stderr || (error instanceof Error ? error.message : String(error));
  console.error(`${prefix}：${redactDatabaseUrls(message)}`);
  process.exit(typeof failure.status === "number" ? failure.status : 1);
}
