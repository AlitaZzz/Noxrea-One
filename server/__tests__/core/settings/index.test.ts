/**
 * 系统设置（specs/system-settings-db.md）的真实库回归测试。
 * 锁定：缺失键以默认值播种、已有值不覆盖、重启后读到手工修改、非法值（含空串 / 空白 / Infinity、
 * 超过 1 天的定时器类时长）启动失败并指明键名、初始化前读取直接报错。
 * 库结构由真实迁移（migrate deploy）建立，baseline SQL 随之被覆盖。
 */
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));

const dbPath = path.join(os.tmpdir(), `noxrea-settings-${process.pid}.db`);
const dbUrl = "file:" + dbPath.replace(/\\/g, "/");

let prisma: import("@prisma/client").PrismaClient = null!;
let savedEnv: Record<string, string | undefined> = {};

/** 模拟一次进程重启：丢弃模块缓存（含内存快照），重新加载设置模块。 */
async function restart() {
  vi.resetModules();
  return import("@server/core/settings");
}

beforeAll(async () => {
  savedEnv = { DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: process.env.LOG_LEVEL };
  process.env.DATABASE_URL = dbUrl;
  process.env.LOG_LEVEL = "ERROR";
  execSync("npx prisma migrate deploy", {
    // core/settings → core → __tests__ → server → 仓库根
    cwd: path.resolve(import.meta.dirname ?? ".", "../../../.."),
    env: { ...process.env },
    stdio: "pipe",
  });
  prisma = (await import("@server/core/database/client")).prisma;
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* Windows 句柄延迟释放 */ }
  }
  process.env.DATABASE_URL = savedEnv.DATABASE_URL;
  process.env.LOG_LEVEL = savedEnv.LOG_LEVEL;
});

beforeEach(async () => {
  await prisma.systemSetting.deleteMany();
});

describe("系统设置播种与读取（真实 SQLite 库）", () => {
  it("初始化前读取直接报错，提示先 bootstrap", async () => {
    const settings = await restart();
    expect(() => settings.getSetting("auth.registration_enabled")).toThrow(/not initialized/);
  });

  it("全新库：注册表全部键以默认值写入，并按类型读取", async () => {
    const settings = await restart();
    const { SETTING_DEFS } = await import("@server/core/settings/registry");

    await settings.initSettings();

    const rows = await prisma.systemSetting.findMany();
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(SETTING_DEFS).sort());
    expect(settings.getSetting("auth.registration_enabled")).toBe(true);
    expect(settings.getSetting("auth.token_ttl_minutes")).toBe(1440);
    expect(settings.getSetting("worker.async_poll_initial_delay_seconds")).toBe(0.5);
    expect(settings.getSetting("storage.gc_dry_run")).toBe(true);
    expect(settings.getSetting("network.outbound_proxy_url")).toBe("");
    expect(rows.find((r) => r.key === "storage.gc_dry_run")?.value).toBe("true");
  });

  it("库中已有值不被默认值覆盖，缺失键仍补齐", async () => {
    await prisma.systemSetting.create({ data: { key: "auth.token_ttl_minutes", value: "60" } });
    const settings = await restart();

    await settings.initSettings();

    expect(settings.getSetting("auth.token_ttl_minutes")).toBe(60);
    expect(settings.getSetting("worker.max_concurrency")).toBe(10);
    const row = await prisma.systemSetting.findUnique({ where: { key: "auth.token_ttl_minutes" } });
    expect(row?.value).toBe("60");
  });

  it("重复启动幂等，且手工修改的值在重启后生效", async () => {
    const first = await restart();
    await first.initSettings();
    const count = await prisma.systemSetting.count();

    await prisma.systemSetting.update({
      where: { key: "auth.registration_enabled" },
      data: { value: "false" },
    });
    const second = await restart();
    await second.initSettings();

    expect(await prisma.systemSetting.count()).toBe(count);
    expect(second.getSetting("auth.registration_enabled")).toBe(false);
  });

  it("同一进程内重复 initSettings 不重复读库（快照不变）", async () => {
    const settings = await restart();
    await settings.initSettings();
    await prisma.systemSetting.update({
      where: { key: "worker.max_concurrency" },
      data: { value: "3" },
    });

    await settings.initSettings();

    expect(settings.getSetting("worker.max_concurrency")).toBe(10);
  });

  it("库中存在非法值时启动失败，错误信息列出全部非法键", async () => {
    await prisma.systemSetting.createMany({
      data: [
        { key: "worker.max_concurrency", value: "abc" },
        { key: "storage.gc_dry_run", value: "yes" },
        { key: "network.trusted_proxy_cidrs", value: "not-a-cidr" },
      ],
    });
    const settings = await restart();

    const error = await settings.initSettings().then(() => null, (e: Error) => e);

    expect(error?.message).toContain("worker.max_concurrency");
    expect(error?.message).toContain("storage.gc_dry_run");
    expect(error?.message).toContain("network.trusted_proxy_cidrs");
    expect(() => settings.getSetting("worker.max_concurrency")).toThrow(/not initialized/);
  });

  it.each([
    ["空串", ""],
    ["空白", "  "],
    ["Infinity", "Infinity"],
    ["科学计数法", "1e3"],
    ["负数", "-1"],
    ["小数", "1.5"],
  ])("整数设置的非法文本（%s）启动失败", async (_label, value) => {
    await prisma.systemSetting.create({ data: { key: "worker.max_retries", value } });
    const settings = await restart();

    await expect(settings.initSettings()).rejects.toThrow(/worker\.max_retries/);
  });

  it.each([["空串", ""], ["Infinity", "Infinity"], ["零", "0"]])(
    "正小数设置的非法文本（%s）启动失败",
    async (_label, value) => {
      await prisma.systemSetting.create({ data: { key: "http.api_timeout_seconds", value } });
      const settings = await restart();

      await expect(settings.initSettings()).rejects.toThrow(/http\.api_timeout_seconds/);
    },
  );

  it.each([
    ["network.outbound_proxy_url", "127.0.0.1:7897"],
    ["network.outbound_proxy_url", "socks5://127.0.0.1:1080"],
    ["network.public_base_url", "canvas.example.com"],
  ])("URL 设置 %s 的非法值（%s）启动失败", async (key, value) => {
    await prisma.systemSetting.create({ data: { key, value } });
    const settings = await restart();

    await expect(settings.initSettings()).rejects.toThrow(key);
  });

  it("URL 设置留空或为 http(s) 地址时通过", async () => {
    await prisma.systemSetting.createMany({
      data: [
        { key: "network.outbound_proxy_url", value: "http://127.0.0.1:7897" },
        { key: "network.public_base_url", value: "https://canvas.example.com" },
      ],
    });
    const settings = await restart();

    await settings.initSettings();

    expect(settings.getSetting("network.outbound_proxy_url")).toBe("http://127.0.0.1:7897");
    expect(settings.getSetting("network.public_base_url")).toBe("https://canvas.example.com");
  });

  it("允许下限为 0 的整数设置取 0", async () => {
    await prisma.systemSetting.create({ data: { key: "worker.max_retries", value: "0" } });
    const settings = await restart();

    await settings.initSettings();

    expect(settings.getSetting("worker.max_retries")).toBe(0);
  });

  it("媒体并发门 11 个设置项按注册表默认值写入（specs/media-processing-concurrency.md）", async () => {
    const settings = await restart();

    await settings.initSettings();

    expect(settings.getSetting("media.ffmpeg_heavy_max_concurrency")).toBe(2);
    expect(settings.getSetting("media.ffmpeg_heavy_max_pending")).toBe(4);
    expect(settings.getSetting("media.ffmpeg_heavy_max_wait_seconds")).toBe(60);
    expect(settings.getSetting("media.ffmpeg_heavy_user_max_concurrency")).toBe(1);
    expect(settings.getSetting("media.ffmpeg_heavy_user_max_pending")).toBe(2);
    expect(settings.getSetting("media.ffmpeg_light_max_concurrency")).toBe(2);
    expect(settings.getSetting("media.ffmpeg_light_max_pending")).toBe(16);
    expect(settings.getSetting("media.ffmpeg_light_max_wait_seconds")).toBe(10);
    expect(settings.getSetting("media.sharp_max_concurrency")).toBe(2);
    expect(settings.getSetting("media.sharp_max_pending")).toBe(64);
    expect(settings.getSetting("media.sharp_max_wait_seconds")).toBe(10);
  });

  it.each(["media.ffmpeg_heavy_max_concurrency", "media.ffmpeg_light_max_concurrency", "media.sharp_max_concurrency"])(
    "媒体池并发上限 %s 取 0 时启动失败",
    async (key) => {
      await prisma.systemSetting.create({ data: { key, value: "0" } });
      const settings = await restart();

      await expect(settings.initSettings()).rejects.toThrow(key);
    },
  );

  it("媒体池队列深度允许取 0（不排队，满即拒）", async () => {
    await prisma.systemSetting.createMany({
      data: [
        { key: "media.ffmpeg_heavy_max_pending", value: "0" },
        { key: "media.ffmpeg_heavy_user_max_pending", value: "0" },
        { key: "media.ffmpeg_light_max_pending", value: "0" },
        { key: "media.sharp_max_pending", value: "0" },
      ],
    });
    const settings = await restart();

    await settings.initSettings();

    expect(settings.getSetting("media.ffmpeg_heavy_max_pending")).toBe(0);
    expect(settings.getSetting("media.ffmpeg_heavy_user_max_pending")).toBe(0);
    expect(settings.getSetting("media.ffmpeg_light_max_pending")).toBe(0);
    expect(settings.getSetting("media.sharp_max_pending")).toBe(0);
  });

  // 超出 Node 定时器上限（约 24.8 天）的延迟不会报错，而是被改成 1ms，必须在启动期拒绝
  it.each([
    ["media.ffmpeg_heavy_max_wait_seconds", "86400.5"],
    ["http.api_timeout_seconds", "2147484"],
    ["worker.drain_timeout_seconds", "86401"],
    ["worker.poll_check_interval_ms", "86400001"],
  ])("定时器类时长 %s 超过 1 天（%s）启动失败", async (key, value) => {
    await prisma.systemSetting.create({ data: { key, value } });
    const settings = await restart();

    await expect(settings.initSettings()).rejects.toThrow(key);
  });

  it("定时器类时长取 1 天上限时通过", async () => {
    await prisma.systemSetting.createMany({
      data: [
        { key: "media.ffmpeg_light_max_wait_seconds", value: "86400" },
        { key: "worker.poll_interval_seconds", value: "86400" },
        { key: "worker.poll_check_interval_ms", value: "86400000" },
      ],
    });
    const settings = await restart();

    await settings.initSettings();

    expect(settings.getSetting("media.ffmpeg_light_max_wait_seconds")).toBe(86400);
    expect(settings.getSetting("worker.poll_interval_seconds")).toBe(86400);
    expect(settings.getSetting("worker.poll_check_interval_ms")).toBe(86_400_000);
  });

  it("不换算成定时器的时长不受 1 天上限约束", async () => {
    await prisma.systemSetting.createMany({
      data: [
        { key: "auth.token_ttl_minutes", value: "43200" },
        { key: "storage.gc_grace_hours", value: "720" },
      ],
    });
    const settings = await restart();

    await settings.initSettings();

    expect(settings.getSetting("auth.token_ttl_minutes")).toBe(43200);
    expect(settings.getSetting("storage.gc_grace_hours")).toBe(720);
  });

  it("代理路由仅在开关打开且地址非空时启用", async () => {
    await prisma.systemSetting.createMany({
      data: [
        { key: "network.outbound_proxy_enabled", value: "true" },
        { key: "network.outbound_proxy_url", value: "" },
      ],
    });
    const settings = await restart();
    await settings.initSettings();
    const { isProxyRoutingEnabled } = await import("@server/core/settings/proxy");
    expect(isProxyRoutingEnabled()).toBe(false);

    await prisma.systemSetting.update({
      where: { key: "network.outbound_proxy_url" },
      data: { value: "http://127.0.0.1:7897" },
    });
    const restarted = await restart();
    await restarted.initSettings();
    const proxy = await import("@server/core/settings/proxy");
    expect(proxy.isProxyRoutingEnabled()).toBe(true);
  });
});
