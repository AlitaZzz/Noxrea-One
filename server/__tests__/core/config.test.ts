/**
 * 引导配置校验（specs/observability-baseline.md 规则 2.3）：
 * 指标端点开启即必须配置 token——不允许「开了指标但没鉴权」。
 * config 模块缓存单例，逐用例 resetModules 后重新加载。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = {
  METRICS_ENABLED: process.env.METRICS_ENABLED,
  METRICS_TOKEN: process.env.METRICS_TOKEN,
};

function restore(name: keyof typeof saved): void {
  const value = saved[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.METRICS_ENABLED;
  delete process.env.METRICS_TOKEN;
  // 其余必填项取 .env 或保守缺省，让断言只针对指标相关校验
  process.env.JWT_SECRET_KEY ??= "test-secret";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.ALLOW_INSECURE_SECRETS = "true";
});

afterEach(() => {
  restore("METRICS_ENABLED");
  restore("METRICS_TOKEN");
});

async function loadConfig() {
  return (await import("@server/core/config")).loadConfig();
}

describe("METRICS_* 配置", () => {
  it("默认关闭：enabled=false、token 为空", async () => {
    const config = await loadConfig();
    expect(config.METRICS_ENABLED).toBe(false);
    expect(config.METRICS_TOKEN).toBe("");
  });

  it("开启但未配 token：启动失败并指明键名", async () => {
    process.env.METRICS_ENABLED = "true";
    await expect(loadConfig()).rejects.toThrow(/METRICS_TOKEN/);
  });

  it("开启且配了 token：通过，且同时接受 1/0 形态", async () => {
    process.env.METRICS_ENABLED = "1";
    process.env.METRICS_TOKEN = "s3cret-token";
    const config = await loadConfig();
    expect(config.METRICS_ENABLED).toBe(true);
    expect(config.METRICS_TOKEN).toBe("s3cret-token");
  });

  it("关闭时不要求 token（指标端点 404）", async () => {
    process.env.METRICS_ENABLED = "false";
    await expect(loadConfig()).resolves.toMatchObject({ METRICS_ENABLED: false });
  });
});
