/**
 * 限流客户端 IP 解析。
 *
 * X-Forwarded-For 由请求方可写，不能默认信任。只有当前 socket 的直连 peer
 * 命中显式配置的可信代理网段时，才从右向左解析代理链；否则一律使用 peer 地址。
 */
import ipaddr from "ipaddr.js";

type ParsedAddress = ReturnType<typeof ipaddr.process>;
type TrustedRange = [ParsedAddress, number];

export interface ResolveRateLimitIpInput {
  remoteAddress?: string | null;
  forwardedFor?: string | null;
  trustedProxyCidrs: string;
}

function parseAddress(value: string): ParsedAddress | null {
  try {
    return ipaddr.process(value);
  } catch {
    return null;
  }
}

function parseTrustedRange(entry: string): TrustedRange | null {
  if (entry.includes("/")) {
    try {
      const [network, bits] = ipaddr.parseCIDR(entry);
      return [network, bits];
    } catch {
      return null;
    }
  }

  const address = parseAddress(entry);
  if (!address) return null;
  return [address, address.kind() === "ipv4" ? 32 : 128];
}

function parseTrustedRanges(value: string): TrustedRange[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseTrustedRange(entry))
    .filter((range): range is TrustedRange => range !== null);
}

export function isValidTrustedProxyCidrs(value: string): boolean {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.every((entry) => parseTrustedRange(entry) !== null);
}

function isTrusted(address: ParsedAddress, ranges: TrustedRange[]): boolean {
  return ranges.some(([network, bits]) => {
    try {
      return address.match([network, bits]);
    } catch {
      // IPv4/IPv6 族不匹配时 match 会抛错，按“不信任”处理。
      return false;
    }
  });
}

export function resolveRateLimitIp(input: ResolveRateLimitIpInput): string {
  const remote = parseAddress((input.remoteAddress ?? "").trim());
  if (!remote) return "unknown";

  const trustedRanges = parseTrustedRanges(input.trustedProxyCidrs);
  const remoteText = remote.toNormalizedString();
  if (trustedRanges.length === 0 || !isTrusted(remote, trustedRanges)) {
    return remoteText;
  }

  const forwarded = (input.forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // XFF 由代理追加：右侧更接近本服务。跳过可信代理后，
  // 第一个非可信地址才是应限流的客户端；非法链路直接退回可信 peer。
  for (let i = forwarded.length - 1; i >= 0; i--) {
    const address = parseAddress(forwarded[i]);
    if (!address) return remoteText;
    if (isTrusted(address, trustedRanges)) continue;
    return address.toNormalizedString();
  }

  return remoteText;
}
