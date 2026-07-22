"""
SSRF 防护公共服务。

从 routers/ai_proxy.py 抽出，供 ai_proxy 与 worker 生成链路共用：
  - DNS Pinning：防御 DNS rebinding（协程级 ContextVar，并发安全）
  - 私网 IP 检测 + hostname 黑名单 + 内网白名单
  - resolve_and_validate(base_url)：解析并校验，返回 (ip, hostname, scheme, port)
  - dns_pin(hostname, ip, port)：请求级 DNS 锁定上下文管理器
  - SSRFRedirectValidator：httpx event hook，对重定向目标逐跳重新校验

新增网络请求转发功能时务必调用 resolve_and_validate；详见 docs/architecture-notes.md。
"""

import logging
import re
import socket
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, status

from app.config import settings

logger = logging.getLogger(__name__)


# ── DNS Pinning（防御 DNS rebinding）────────────────

# 协程级别的 DNS 锁定：每个并发请求有自己独立的 pin 状态，互不干扰
_dns_pin_var: ContextVar[dict[str, list] | None] = ContextVar(
    "_dns_pin", default=None
)
_original_getaddrinfo = socket.getaddrinfo


def _pinned_getaddrinfo(host, port, *args, **kwargs):
    pin = _dns_pin_var.get()
    if pin and host in pin:
        return pin[host]
    return _original_getaddrinfo(host, port, *args, **kwargs)


# 模块加载时全局替换一次。
# 对未 pin 的 hostname 完全透明地回退到原始行为，无性能损失：
# 一次函数调用 + 一次 ContextVar.get(default=None) -> 很快
socket.getaddrinfo = _pinned_getaddrinfo


@contextmanager
def dns_pin(hostname: str, ip: str, port: int):
    """临时锁定 hostname -> ip 的 DNS 解析。请求级 scope，协程安全。"""
    entry = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, port))]
    token = _dns_pin_var.set({hostname: entry})
    try:
        yield
    finally:
        _dns_pin_var.reset(token)


# ── SSRF 防护 ───────────────────────────────────────

_PRIVATE_IP_PREFIXES = [
    "10.",
    "192.168.",
    "127.",
    "0.",
    "169.254.",
    "172.16.", "172.17.", "172.18.", "172.19.",
    "172.20.", "172.21.", "172.22.", "172.23.",
    "172.24.", "172.25.", "172.26.", "172.27.",
    "172.28.", "172.29.", "172.30.", "172.31.",
    "fc00:", "fd00:",
    "::1",
]

_HOSTNAME_BLOCKLIST = [
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
]

# 从环境变量加载白名单
_ALLOWED_INTERNAL_HOSTS: list[str] = []
if settings.ALLOWED_INTERNAL_HOSTS:
    _ALLOWED_INTERNAL_HOSTS = [
        h.strip() for h in settings.ALLOWED_INTERNAL_HOSTS.split(",") if h.strip()
    ]


def _raise_bad_url(msg: str):
    # 所有 SSRF / 非法 baseUrl 拦截统一在此告警，便于发现探测行为
    logger.warning(f"ssrf blocked: {msg}")
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)


def _is_allowed(ip: str) -> bool:
    return ip in _ALLOWED_INTERNAL_HOSTS


def _is_private_ip(ip: str) -> bool:
    for prefix in _PRIVATE_IP_PREFIXES:
        if ip.startswith(prefix):
            return True
    return False


def resolve_and_validate(base_url: str) -> tuple[str, str, str, int]:
    """
    解析 baseUrl -> 校验全部解析到的 IP。

    返回 (ip, hostname, scheme, port)：
      - ip：通过校验的 IPv4 地址（用于 DNS pinning）
      - hostname：原始域名
      - scheme："http" | "https"
      - port：端口号
    """
    url = base_url.rstrip("/")

    if not (url.startswith("http://") or url.startswith("https://")):
        _raise_bad_url("baseUrl must start with http:// or https://")

    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    scheme = parsed.scheme
    port = parsed.port or (443 if scheme == "https" else 80)

    if hostname in _HOSTNAME_BLOCKLIST:
        _raise_bad_url(f"baseUrl pointing to '{hostname}' is not allowed")

    # IP 字面量 -> 直接校验
    ipv4_match = re.match(r"^(\d{1,3}\.){3}\d{1,3}$", hostname)
    if ipv4_match:
        if _is_allowed(hostname):
            return hostname, hostname, scheme, port
        if _is_private_ip(hostname):
            _raise_bad_url(
                f"baseUrl pointing to private network ({hostname}) is not allowed"
            )
        return hostname, hostname, scheme, port

    # 域名 -> DNS 解析全部 IP
    try:
        addrs = socket.getaddrinfo(hostname, port, family=socket.AF_INET)
    except socket.gaierror:
        _raise_bad_url(f"Cannot resolve hostname: {hostname}")

    resolved_ips = list(dict.fromkeys(addr[4][0] for addr in addrs))
    if not resolved_ips:
        _raise_bad_url(f"No IPv4 address found for: {hostname}")

    # 逐个校验
    for ip in resolved_ips:
        if _is_allowed(ip):
            continue
        if _is_private_ip(ip):
            _raise_bad_url(
                f"baseUrl '{hostname}' resolves to private IP ({ip}), not allowed"
            )

    return resolved_ips[0], hostname, scheme, port


# ── 重定向逐跳校验（httpx event hook）──────────────

class SSRFRedirectValidator:
    """httpx event hook：对每个重定向响应的 Location 重新走 resolve_and_validate。

    用法：作为 event_hooks={'response': [hook.async_response]} 传入 AsyncClient。
    触发条件：3xx 且有 Location 头。校验失败抛 HTTPException 400（已记录 ssrf blocked）。
    """

    async def async_response(self, response: httpx.Response):
        if not response.is_redirect:
            return
        location = response.headers.get("location")
        if not location:
            return
        # 相对 Location -> 基于本次请求 URL 解析绝对地址
        base = str(response.request.url)
        target = str(httpx.URL(location))
        if location.startswith("/"):
            parsed_base = urlparse(base)
            target = f"{parsed_base.scheme}://{parsed_base.netloc}{location}"
        resolve_and_validate(target)
