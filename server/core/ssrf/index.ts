/**
 * SSRF 防护。
 * 白名单式地址校验（仅放行 unicast 公网地址）+ 连接级 DNS pinning：
 * 校验发生在建连的 lookup 阶段，连接实际使用的就是通过校验的 IP，
 * 消除「校验与连接各解析一次 DNS」的 rebinding（TOCTOU）窗口，并覆盖重定向后的每一跳。
 */
import dns from "dns/promises";
import net from "node:net";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";
import { getConfig } from "@server/core/config";

function getAllowedInternalHosts(): string[] {
  const raw = getConfig().ALLOWED_INTERNAL_HOSTS;
  if (!raw) return [];
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function isHostAllowed(hostname: string): boolean {
  return getAllowedInternalHosts().includes(hostname.toLowerCase());
}

function isIpAllowed(ip: string): boolean {
  if (getAllowedInternalHosts().includes(ip)) return true;
  const addr = ipaddr.parse(ip);
  // ::ffff:x.x.x.x 映射地址展开为 IPv4 再判，防止内网地址套 v6 伪装绕过
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    const v4 = (addr as ipaddr.IPv6).toIPv4Address();
    if (v4.range() !== "unicast") {
      throw new Error(`SSRF blocked: ${ip} → ${v4.toString()} is a ${v4.range()} address`);
    }
    return true;
  }
  const range = addr.range();
  if (range !== "unicast") {
    throw new Error(`SSRF blocked: ${ip} is a ${range} address`);
  }
  return true;
}

/** 解析 hostname（含 IP 字面量）为地址列表，非白名单目标逐个校验，违规即抛错。 */
async function resolveForConnection(hostname: string): Promise<LookupAddress[]> {
  const allowInternal = isHostAllowed(hostname);
  // URL.hostname 对 IPv6 字面量保留方括号（"[::1]"），先剥掉
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  const literalFamily = net.isIP(bare);
  if (literalFamily !== 0) {
    if (!allowInternal) isIpAllowed(bare);
    return [{ address: bare, family: literalFamily }];
  }

  // dns.lookup 走 getaddrinfo（含 /etc/hosts），与真实建连的解析行为一致；
  // resolve4/6 只查递归 DNS，会漏掉 hosts 文件映射的内网入口
  const addresses = await dns.lookup(bare, { all: true });
  if (!allowInternal) {
    for (const { address } of addresses) isIpAllowed(address);
  }
  return addresses;
}

/**
 * 预检入口：解析并校验地址，返回通过校验的全部地址。
 * 用于代理模式（DNS 由代理解析，lookup pinning 不生效）下的守卫与早期失败提示；
 * 直连模式下真正建连时还会由 ssrfLookup 再校验一次。
 */
export async function resolveAndValidate(hostname: string): Promise<string[]> {
  const addresses = await resolveForConnection(hostname);
  return addresses.map((a) => a.address);
}

/** net 风格 LookupFunction：解析 + 校验一体，返回给 net.connect 的就是校验通过的 IP。 */
const ssrfLookup: LookupFunction = (hostname, options, callback) => {
  resolveForConnection(hostname).then(
    (addresses) => {
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const family = options.family ?? 0;
      const pool = family === 0 ? addresses : addresses.filter((a) => a.family === family);
      const chosen = (pool.length > 0 ? pool : addresses)[0];
      callback(null, chosen.address, chosen.family);
    },
    (err: Error) => callback(err, "")
  );
};

/**
 * SSRF 校验型 Agent：作为直连 fetch 的默认 dispatcher。
 * 按 connect timeout 分档缓存（场景超时来自固定的小集合）。
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const agents = new Map<number, Agent>();

export function getSsrfAgent(connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS): Agent {
  let agent = agents.get(connectTimeoutMs);
  if (!agent) {
    agent = new Agent({ connect: { timeout: connectTimeoutMs, lookup: ssrfLookup } });
    agents.set(connectTimeoutMs, agent);
  }
  return agent;
}
