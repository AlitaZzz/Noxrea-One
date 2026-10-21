/**
 * 「未分类」目录部分唯一约束（迁移 20261015213000_uncategorized_unique）的真实库回归测试。
 * 锁定：同用户同 scope 的第二个 kind='uncategorized' 目录被部分唯一索引拒绝、
 * 普通目录不受部分索引限制（同用户同 scope 可多个）、跨 scope 互不影响。
 */
import type { PrismaClient } from "@server/core/database/generated/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isUniqueConstraintViolation } from "@server/core/database/errors";
import { databaseTestsEnabled, setupTestDatabase } from "../helpers/test-database";

let prisma: PrismaClient | null = null;
let cleanup: (() => Promise<void>) | null = null;

beforeAll(async () => {
  cleanup = await setupTestDatabase();
  // 环境变量就位后才能实例化客户端（连接串在构造时读取）
  const client = await import("@server/core/database/client");
  prisma = client.prisma;

  await prisma.user.create({ data: { username: "folder-u1", hashedPassword: "h" } });
}, 60_000);

// afterAll 必须在顶层注册：嵌套在 beforeAll 内注册不会生效，测试库连接与环境变量永远不会被清理
afterAll(async () => {
  await cleanup?.();
});

describe.skipIf(!databaseTestsEnabled)("asset_folders 部分唯一索引（真实 PostgreSQL 库）", () => {
  it("同用户同 scope 的第二个「未分类」目录被拒绝，冲突字段为 user_id+scope", async () => {
    const userId = 1;
    await prisma!.assetFolder.create({
      data: { userId, scope: "personal", name: "Uncategorized", kind: "uncategorized", parentId: null },
    });
    await expect(prisma!.assetFolder.create({
      data: { userId, scope: "personal", name: "Uncategorized", kind: "uncategorized", parentId: null },
    })).rejects.toSatisfy((error: unknown) => isUniqueConstraintViolation(error, "asset_folders_uncategorized_key"));
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
