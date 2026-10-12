import { getSetting } from "@server/core/settings";

/**
 * 出站 HTTP 是否走配置的代理。代理模式下出站 DNS 由代理解析，
 * 本地解析结果与实际连接路径无关（SSRF 预检随之降级，见 core/ssrf）。
 */
export function isProxyRoutingEnabled(): boolean {
  return getSetting("network.outbound_proxy_enabled") && getSetting("network.outbound_proxy_url") !== "";
}
