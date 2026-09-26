/**
 * SSRF 防护回归测试。
 * 核心语义：
 *  - 多地址解析按「剔除可疑、保留可用」处理（AAAA 特殊段不连坐有效的 A 记录）；
 *  - 全部地址非 unicast 才拦截（fake-IP 场景）；
 *  - 代理模式下预检降级为告警，不拦截（DNS 由代理解析，本地结果与实际路径无关）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfig, isProxyRoutingEnabled, lookup, logger } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  isProxyRoutingEnabled: vi.fn(),
  lookup: vi.fn(),
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("@server/core/config", () => ({ getConfig, isProxyRoutingEnabled }));
vi.mock("@server/core/logger", () => ({ logger }));
vi.mock("dns/promises", () => ({ default: { lookup } }));

import { resolveAndValidate } from "./index";

function resolvesTo(...addresses: Array<{ address: string; family: number }>) {
  lookup.mockResolvedValue(addresses);
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockReturnValue({ ALLOWED_INTERNAL_HOSTS: "" });
  isProxyRoutingEnabled.mockReturnValue(false);
});

describe("direct-mode precheck (resolveAndValidate)", () => {
  it("keeps usable records when AAAA falls in a special range alongside a valid A record", async () => {
    resolvesTo(
      { address: "fd12::1", family: 6 },
      { address: "1.2.3.4", family: 4 },
    );
    await expect(resolveAndValidate("api.example.com")).resolves.toEqual(["1.2.3.4"]);
    expect(lookup).toHaveBeenCalledWith("api.example.com", { all: true });
  });

  it("filters the fake-IP range (198.18.0.0/15) but passes when a real record exists", async () => {
    resolvesTo(
      { address: "198.18.0.5", family: 4 },
      { address: "104.18.1.2", family: 4 },
    );
    await expect(resolveAndValidate("api.example.com")).resolves.toEqual(["104.18.1.2"]);
  });

  it("rejects when every resolved address is non-unicast", async () => {
    resolvesTo({ address: "198.18.0.5", family: 4 });
    await expect(resolveAndValidate("api.example.com")).rejects.toThrow(/non-unicast addresses only/);
  });

  it("returns all records unfiltered for whitelisted hosts", async () => {
    getConfig.mockReturnValue({ ALLOWED_INTERNAL_HOSTS: "intranet.local, 10.0.0.5" });
    resolvesTo({ address: "10.0.0.5", family: 4 }, { address: "fd00::1", family: 6 });
    await expect(resolveAndValidate("intranet.local")).resolves.toEqual(["10.0.0.5", "fd00::1"]);
  });

  it("accepts global unicast literals of both families", async () => {
    await expect(resolveAndValidate("1.2.3.4")).resolves.toEqual(["1.2.3.4"]);
    await expect(resolveAndValidate("[2606:4700::1111]")).resolves.toEqual(["2606:4700::1111"]);
  });

  it("rejects private, loopback and CGNAT literals", async () => {
    await expect(resolveAndValidate("10.1.2.3")).rejects.toThrow(/private/);
    await expect(resolveAndValidate("127.0.0.1")).rejects.toThrow(/loopback/);
    await expect(resolveAndValidate("100.64.0.7")).rejects.toThrow(/carrierGradeNat/);
  });

  it("unwraps IPv4-mapped IPv6 literals and judges the inner IPv4", async () => {
    await expect(resolveAndValidate("::ffff:1.2.3.4")).resolves.toEqual(["::ffff:1.2.3.4"]);
    await expect(resolveAndValidate("::ffff:192.168.0.1")).rejects.toThrow(/192\.168\.0\.1 is a private/);
  });

  it("rejects ULA IPv6 literals", async () => {
    await expect(resolveAndValidate("fd00::1")).rejects.toThrow(/uniqueLocal/);
  });
});

describe("proxy-mode precheck", () => {
  beforeEach(() => {
    isProxyRoutingEnabled.mockReturnValue(true);
  });

  it("does not fail the task when local resolution lands entirely in the fake-IP range", async () => {
    resolvesTo({ address: "198.18.0.5", family: 4 });
    await expect(resolveAndValidate("api.example.com")).resolves.toEqual([]);
    // 审计告警必须保留：这是代理模式下唯一的可疑目标可见性
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "api.example.com" }),
      expect.stringContaining("non-fatal"),
    );
  });

  it("still resolves and warns for auditability, but never throws", async () => {
    resolvesTo({ address: "10.0.0.5", family: 4 });
    await expect(resolveAndValidate("api.example.com")).resolves.toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
