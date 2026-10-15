/**
 * 「未分类」目录部分唯一约束（迁移 20261015213000_uncategorized_unique）的真实库回归测试。
 * 锁定：同用户同 scope 的第二个 kind='uncategorized' 目录被部分唯一索引拒绝、
 * 普通目录不受部分索引限制（同用户同 scope 可多个）、跨 scope 互不影响。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { PrismaClient } from "@server/core/database/generated/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isUniqueConstraintError } from "@server/core/database/errors";

// 本地模式数据目录（PGlite）；client 模块在环境变量就位后才首次导入
const dbDir = path.join(os.tmpdir(), `noxrea-asset-folder-constraint-${process.pid}`);
const dbUrl = "file:" + dbDir.replace(/\\/g, "/");

let prisma: PrismaClient | null = null;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // 保存并最终恢复被本测试改写的环境，避免污染同 worker 的后续测试文件
  savedEnv = { DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: process.env.LOG_LEVEL };
  process.env.DATABASE_URL = dbUrl;
  process.env.LOG_LEVEL = "ERROR";
  // 环境变量就位后才能实例化客户端（连接串在构造时读取）
  const client = await import("@server/core/database/client");
  prisma = client.prisma;

  // 与生产启动一致：应用 prisma/migrations 增量（幂等，含手写的部分唯一索引迁移）
  await client.ensureLocalMigrations();

  await prisma.user.create({ data: { username: "folder-u1", hashedPassword: "h" } });
}, 60_000);

// afterAll 必须在顶层注册：嵌套在 beforeAll 内注册不会生效，临时库与环境变量永远不会被清理
afterAll(async () => {
  await prisma?.$disconnect();
  await (await import("@server/core/database/client")).closeLocalDatabase();
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
  process.env.DATABASE_URL = savedEnv.DATABASE_URL;
  process.env.LOG_LEVEL = savedEnv.LOG_LEVEL;
});

describe("asset_folders 部分唯一索引（真实 PGlite 库）", () => {
  it("同用户同 scope 的第二个「未分类」目录被拒绝，冲突字段为 user_id+scope", async () => {
    const userId = 1;
    await prisma!.assetFolder.create({
      data: { userId, scope: "personal", name: "Uncategorized", kind: "uncategorized", parentId: null },
    });
    await expect(prisma!.assetFolder.create({
      data: { userId, scope: "personal", name: "Uncategorized", kind: "uncategorized", parentId: null },
    })).rejects.toSatisfy((error: unknown) => isUniqueConstraintError(error, "user_id", "scope"));
  });

  it("普通目录不受部分索引限制：同用户同 scope 可建多个", async () => {
    const userId = 1;
    await prisma!.assetFolder.create({
      data: { userId, scope: "personal", name: "常规一", kind: "normal", parentId: null },
    });
    await expect(prisma!.assetFolder.create({
      data: { userId, scope: "personal", name: "常规二", kind: "normal", parentId: null },
    })).resolves.toMatchObject({ kind: "normal" });
  });

  it("不同 scope 的「未分类」目录互不影响", async () => {
    const userId = 1;
    await expect(prisma!.assetFolder.create({
      data: { userId, scope: "shared", name: "Uncategorized", kind: "uncategorized", parentId: null },
    })).resolves.toMatchObject({ scope: "shared" });
  });
});
