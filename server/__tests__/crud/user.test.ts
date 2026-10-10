/**
 * 用户表升级（specs/user-table-upgrade.md）的真实库回归测试。
 * 锁定：首个注册用户自动 admin、后续 user、lastLoginAt 写入、email 唯一约束、
 * 多个 NULL email 共存、toPublicUser 的 displayName 展示回退。
 */
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeUser } from "../helpers/user-fixture";

const dbPath = path.join(os.tmpdir(), `noxrea-user-upgrade-${process.pid}.db`);
const dbUrl = "file:" + dbPath.replace(/\\/g, "/");

let prisma: import("@prisma/client").PrismaClient | null = null;
let createUser: typeof import("@server/crud/user").createUser = null!;
let touchLastLogin: typeof import("@server/crud/user").touchLastLogin = null!;
let toPublicUser: typeof import("@server/crud/user").toPublicUser = null!;

beforeAll(async () => {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: process.env.LOG_LEVEL };
  process.env.DATABASE_URL = dbUrl;
  process.env.LOG_LEVEL = "ERROR";
  const client = await import("@server/core/database/client");
  const crud = await import("@server/crud/user");
  prisma = client.prisma;
  createUser = crud.createUser;
  touchLastLogin = crud.touchLastLogin;
  toPublicUser = crud.toPublicUser;

  execSync("npx prisma db push --skip-generate", {
    // crud → server → 仓库根
    cwd: path.resolve(import.meta.dirname ?? ".", "../../.."),
    env: { ...process.env },
    stdio: "pipe",
  });
  await client.applyPragmas();

  afterAll(async () => {
    await prisma?.$disconnect();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* Windows 句柄延迟释放 */ }
    }
    process.env.DATABASE_URL = saved.DATABASE_URL;
    process.env.LOG_LEVEL = saved.LOG_LEVEL;
  });
}, 60_000);

describe("用户表升级（真实 SQLite 库）", () => {
  it("首个注册用户自动 admin，后续用户为 user", async () => {
    const first = await createUser({ username: "alice", hashedPassword: "h1" });
    const second = await createUser({ username: "bob", hashedPassword: "h2" });

    expect(first.role).toBe("admin");
    expect(second.role).toBe("user");
  });

  it("email 唯一约束拒绝重复，多个 NULL email 共存", async () => {
    await createUser({ username: "with-mail-1", hashedPassword: "h" });
    await prisma!.user.update({ where: { username: "with-mail-1" }, data: { email: "a@example.com" } });

    await expect(prisma!.user.create({
      data: { username: "with-mail-2", hashedPassword: "h", email: "a@example.com" },
    })).rejects.toMatchObject({ code: "P2002" });

    // 两个未填 email（NULL）的用户共存不冲突
    const u2 = await createUser({ username: "null-mail-1", hashedPassword: "h" });
    const u3 = await createUser({ username: "null-mail-2", hashedPassword: "h" });
    expect(u2.email).toBeNull();
    expect(u3.email).toBeNull();
  });

  it("touchLastLogin 写入最后登录时间", async () => {
    const u = await createUser({ username: "login-time", hashedPassword: "h" });
    expect(u.lastLoginAt).toBeNull();

    await touchLastLogin(u.id);
    const fresh = await prisma!.user.findUnique({ where: { id: u.id } });
    expect(fresh?.lastLoginAt).not.toBeNull();
  });

  it("displayName 展示回退：为空时按 username，有值时保留", () => {
    expect(toPublicUser(makeUser()).displayName).toBe("alice");
    expect(toPublicUser(makeUser({ displayName: "Alice P" })).displayName).toBe("Alice P");
  });

  it("toPublicUser 暴露 email/role，且不泄漏 hashedPassword/tokenVersion 等内部字段", () => {
    const pub = toPublicUser(makeUser({
      hashedPassword: "secret-hash", role: "admin", email: "a@example.com", tokenVersion: 3,
    }));

    expect(pub).toMatchObject({ role: "admin", email: "a@example.com" });
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain("secret-hash");
    expect(serialized).not.toContain("tokenVersion");
  });
});
