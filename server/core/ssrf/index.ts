import dns from "dns/promises";
import net from "net";
import { getConfig } from "@server/core/config";

// ── SSRF 防护（对应 backend/app/services/ssrf.py） ──
// 全栈架构下仅需保留 resolveAndValidate，防止恶意 baseUrl 指向内网。

const PRIVATE_IP_PREFIXES = [
  "0.", "10.", "100.", "127.", "169.254.",
  "172.16.", "172.17.", "172.18.", "172.19.", "172.20.",
  "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
  "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
  "192.0.0.", "192.0.2.", "192.88.99.", "192.168.",
  "198.18.", "198.19.", "198.51.100.", "203.0.113.",
  "::1", "fc", "fd", "fe80",
];

function isPrivateIp(ip: string): boolean {
  if (ip === "::1") return true;
  if (net.isIPv4(ip)) return PRIVATE_IP_PREFIXES.some((p) => ip.startsWith(p));
  if (net.isIPv6(ip)) return PRIVATE_IP_PREFIXES.some((p) => ip.toLowerCase().startsWith(p));
  return false;
}

function getAllowedInternalHosts(): string[] {
  const raw = getConfig().ALLOWED_INTERNAL_HOSTS;
  if (!raw) return [];
  return raw.split(",").map((h) => h.trim()).filter(Boolean);
}

function isIpAllowed(ip: string): boolean {
  if (getAllowedInternalHosts().includes(ip)) return true;
  return !isPrivateIp(ip);
}

/**
 * DNS 解析 + SSRF 校验，返回第一个通过校验的 IP。
 */
export async function resolveAndValidate(hostname: string): Promise<string> {
  if (net.isIPv4(hostname)) {
    if (!isIpAllowed(hostname)) {
      throw new Error(`SSRF blocked: ${hostname} is a private/internal IP`);
    }
    return hostname;
  }

  const blockedHosts = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
  if (blockedHosts.includes(hostname.toLowerCase())) {
    throw new Error(`SSRF blocked: ${hostname} is blacklisted`);
  }

  let addresses: string[];
  try {
    addresses = await dns.resolve4(hostname);
  } catch {
    throw new Error(`SSRF: DNS resolution failed for ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new Error(`SSRF: no IP addresses resolved for ${hostname}`);
  }

  for (const ip of addresses) {
    if (!isIpAllowed(ip)) {
      throw new Error(`SSRF blocked: ${hostname} → ${ip} is private/internal`);
    }
  }

  return addresses[0];
}
