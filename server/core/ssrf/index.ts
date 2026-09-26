/**
 * SSRF 防护。
 * 白名单式地址校验（仅放行 unicast 公网地址）+ 连接级 DNS pinning：
 * 校验发生在建连的 lookup 阶段，连接实际使用的就是通过校验的 IP，
 * 消除「校验与连接各解析一次 DNS」的 rebinding（TOCTOU）窗口，并覆盖重定向后的每一跳。
 *
 * 多地址解析按「剔除可疑、保留可用」处理：非 unicast 的记录被过滤掉，
 * 只要存在可用地址即可建连（避免 AAAA 落在特殊段时连有效的 A 记录一起被否决），
 * 全部地址被拒才视为违规。
 *
 * 代理模式（USE_SYSTEM_PROXY + PROXY_URL）下出站 DNS 由代理解析，本地解析结果
 * 与实际连接路径无关，预检（resolveAndValidate）降级为日志告警、不作为失败依据；
 * 强制校验只存在于直连模式的建连 pinning。
 */
import dns from "dns/promises";
import net from "node:net";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";
import { getConfig, isProxyRoutingEnabled } from "@server/core/config";
import { logger } from "@server/core/logger";

function getAllowedInternalHosts(): string[] {
  const raw = getConfig().ALLOWED_INTERNAL_HOSTS;
  if (!raw) return [];
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function isHostAllowed(hostname: string): boolean {
  return getAllowedInternalHosts().includes(hostname.toLowerCase());
}

/** 非白名单地址的违规描述；合规返回 null */
function addressViolation(ip: string): string | null {
  if (getAllowedInternalHosts().includes(ip)) return null;
  const addr = ipaddr.parse(ip);
  // ::ffff:x.x.x.x 映射地址展开为 IPv4 再判，防止内网地址套 v6 伪装绕过
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    const v4 = (addr as ipaddr.IPv6).toIPv4Address();
    return v4.range() === "unicast" ? null : `${ip} → ${v4.toString()} is a ${v4.range()} address`;
  }
  const range = addr.range();
  return range === "unicast" ? null : `${ip} is a ${range} address`;
}

/**
 * 解析 hostname（含 IP 字面量）为允许连接的地址列表。
 * 非白名单目标逐个校验：违规地址剔除并记日志，全部被拒才抛错。
 */
async function resolveForConnection(hostname: string): Promise<LookupAddress[]> {
  const allowInternal = isHostAllowed(hostname);
  // URL.hostname 对 IPv6 字面量保留方括号（"[::1]"），先剥掉
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  const literalFamily = net.isIP(bare);
  if (literalFamily !== 0) {
    if (!allowInternal) {
      const violation = addressViolation(bare);
      if (violation) throw new Error(`SSRF blocked: ${violation}`);
    }
    return [{ address: bare, family: literalFamily }];
  }

  // dns.lookup 走 getaddrinfo（含 /etc/hosts），与真实建连的解析行为一致；
  // resolve4/6 只查递归 DNS，会漏掉 hosts 文件映射的内网入口
  const addresses = await dns.lookup(bare, { all: true });
  if (allowInternal) return addresses;

  const violations = addresses.map((a) => addressViolation(a.address));
  const allowed = addresses.filter((_, i) => violations[i] === null);
  if (allowed.length === 0) {
    const detail = violations.filter(Boolean).join("; ");
    throw new Error(`SSRF blocked: ${bare} resolves to non-unicast addresses only (${detail})`);
  }
  if (allowed.length < addresses.length) {
    logger.debug(
      { hostname, filtered: violations.filter(Boolean) },
      "SSRF filtered non-unicast addresses from resolution",
    );
  }
  return allowed;
}

/**
 * 预检入口：解析并校验地址，返回通过校验的全部地址。
 * 直连模式下用于早期失败提示（建连时 ssrfLookup 还会再校验并 pinning）；
 * 代理模式下 DNS 由代理解析，本地结果与实际路径无关，仅告警不拦截。
 */
export async function resolveAndValidate(hostname: string): Promise<string[]> {
  if (isProxyRoutingEnabled()) {
    try {
      await resolveForConnection(hostname);
    } catch (err: unknown) {
      logger.warn(
        { hostname, reason: (err as Error).message },
        "SSRF precheck flagged upstream host in proxy mode (non-fatal; DNS is resolved by the proxy)",
      );
    }
    return [];
  }
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
