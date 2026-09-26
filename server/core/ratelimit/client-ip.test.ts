import { describe, expect, it } from "vitest";

import {
  isValidTrustedProxyCidrs,
  resolveRateLimitIp,
} from "./client-ip";

describe("resolveRateLimitIp", () => {
  it("直连 peer 不在可信代理网段时忽略伪造的 X-Forwarded-For", () => {
    expect(
      resolveRateLimitIp({
        remoteAddress: "203.0.113.10",
        forwardedFor: "198.51.100.1,198.51.100.2",
        trustedProxyCidrs: "10.0.0.0/8",
      }),
    ).toBe("203.0.113.10");
  });

  it("可信代理链从右向左跳过代理并取第一个客户端地址", () => {
    expect(
      resolveRateLimitIp({
        remoteAddress: "10.0.0.1",
        forwardedFor: "198.51.100.10,10.0.0.2,10.0.0.3",
        trustedProxyCidrs: "10.0.0.0/8",
      }),
    ).toBe("198.51.100.10");
  });

  it("整条 XFF 都是可信代理时退回直连可信 peer", () => {
    expect(
      resolveRateLimitIp({
        remoteAddress: "10.0.0.1",
        forwardedFor: "10.0.0.2,10.0.0.3",
        trustedProxyCidrs: "10.0.0.0/8",
      }),
    ).toBe("10.0.0.1");
  });

  it("处理 IPv4-mapped IPv6 并按 IPv4 语义匹配", () => {
    expect(
      resolveRateLimitIp({
        remoteAddress: "::ffff:10.0.0.1",
        forwardedFor: "::ffff:198.51.100.10",
        trustedProxyCidrs: "10.0.0.0/8",
      }),
    ).toBe("198.51.100.10");
  });

  it("非法或缺失 peer 不回落到可伪造头", () => {
    expect(
      resolveRateLimitIp({
        remoteAddress: "not-an-ip",
        forwardedFor: "198.51.100.1",
        trustedProxyCidrs: "10.0.0.0/8",
      }),
    ).toBe("unknown");
  });
});

describe("isValidTrustedProxyCidrs", () => {
  it("接受空配置、单个 IP 与 CIDR 列表", () => {
    expect(isValidTrustedProxyCidrs("")).toBe(true);
    expect(isValidTrustedProxyCidrs("192.0.2.1")).toBe(true);
    expect(isValidTrustedProxyCidrs("10.0.0.0/8, 2001:db8::/32")).toBe(true);
  });

  it("拒绝非法网段", () => {
    expect(isValidTrustedProxyCidrs("10.0.0.0/99")).toBe(false);
    expect(isValidTrustedProxyCidrs("example.com")).toBe(false);
  });
});
