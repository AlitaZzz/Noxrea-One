import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: () => true,
  readFileSync: () => "UPLOAD_BATCH_MAX_MB=128\nSERVER_URL=http://file-backend:4000\n",
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Next 配置与服务端环境一致性", () => {
  it("process.env 优先于根 .env 中的批次限制与代理目标", async () => {
    vi.stubEnv("UPLOAD_BATCH_MAX_MB", "256");
    vi.stubEnv("SERVER_URL", "http://runtime-backend:4000");
    const { default: config } = await import("../../../next.config");
    expect(config.experimental?.proxyClientMaxBodySize).toBe("261mb");
    const rules = await config.rewrites!();
    expect(rules).toEqual([{ source: "/api/:path*", destination: "http://runtime-backend:4000/api/:path*" }]);
  });
});
