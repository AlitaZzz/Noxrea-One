import { afterEach, describe, expect, it, vi } from "vitest";

const rootEnv = vi.hoisted(() => ({ content: "" }));

vi.mock("fs", () => ({
  existsSync: () => true,
  readFileSync: () => rootEnv.content,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadRewrites() {
  const { default: config } = await import("../../../next.config");
  return config.rewrites!();
}

describe("Next 配置与服务端环境一致性", () => {
  it("process.env 优先于根 .env 中的批次限制与代理目标", async () => {
    rootEnv.content = "UPLOAD_BATCH_MAX_MB=128\nWEB_API_ORIGIN=http://file-backend:4000\n";
    vi.stubEnv("UPLOAD_BATCH_MAX_MB", "256");
    vi.stubEnv("WEB_API_ORIGIN", "http://runtime-backend:4000");
    const { default: config } = await import("../../../next.config");
    expect(config.experimental?.proxyClientMaxBodySize).toBe("261mb");
    const rules = await config.rewrites!();
    expect(rules).toEqual([{ source: "/api/:path*", destination: "http://runtime-backend:4000/api/:path*" }]);
  });

  it("WEB_API_ORIGIN 缺省时代理目标随 API_PORT 推导", async () => {
    rootEnv.content = "API_PORT=4001\n";
    vi.stubEnv("WEB_API_ORIGIN", "");
    await expect(loadRewrites()).resolves.toEqual([
      { source: "/api/:path*", destination: "http://localhost:4001/api/:path*" },
    ]);
  });

  it("WEB_API_ORIGIN 与 API_PORT 都缺省时回落 4000，且去除末尾斜杠", async () => {
    rootEnv.content = "";
    vi.stubEnv("WEB_API_ORIGIN", "");
    await expect(loadRewrites()).resolves.toEqual([
      { source: "/api/:path*", destination: "http://localhost:4000/api/:path*" },
    ]);

    vi.resetModules();
    vi.stubEnv("WEB_API_ORIGIN", "http://remote-backend:4000/");
    await expect(loadRewrites()).resolves.toEqual([
      { source: "/api/:path*", destination: "http://remote-backend:4000/api/:path*" },
    ]);
  });
});
