"""
AI 代理接口 — 带鉴权和 SSRF 防护的转发层。

与 /api/generate 的任务队列不同，这里直接转发请求到 AI Provider：
  - POST /api/chat/completions  → {baseUrl}/chat/completions
  - POST /api/models/list       → {baseUrl}/models

所有接口均需 JWT 鉴权 (Depends(get_current_user))。
"""

import re
import socket
from contextlib import contextmanager
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import settings
from app.deps import get_current_user
from app.schemas.common import UnifiedResponse

router = APIRouter(prefix="/api", tags=["ai-proxy"])


# ── 请求体 ──────────────────────────────────────────

class ChatCompletionRequest(BaseModel):
    baseUrl: str
    apiKey: str
    model: str
    messages: list[dict]


class ModelListRequest(BaseModel):
    baseUrl: str
    apiKey: str


# ── DNS Pinning（防御 DNS rebinding）────────────────

import contextvars

# 协程级别的 DNS 锁定：每个并发请求有自己独立的 pin 状态，互不干扰
_dns_pin_var: contextvars.ContextVar[dict[str, list] | None] = (
    contextvars.ContextVar("_dns_pin", default=None)
)
_original_getaddrinfo = socket.getaddrinfo


def _pinned_getaddrinfo(host, port, *args, **kwargs):
    pin = _dns_pin_var.get()
    if pin and host in pin:
        return pin[host]
    return _original_getaddrinfo(host, port, *args, **kwargs)


# 模块加载时全局替换一次。
# 对未 pin 的 hostname 完全透明地回退到原始行为，无性能损失：
# 一次函数调用 + 一次 ContextVar.get(default=None) → 很快
socket.getaddrinfo = _pinned_getaddrinfo


@contextmanager
def _dns_pin(hostname: str, ip: str, port: int):
    """临时锁定 hostname → ip 的 DNS 解析。请求级 scope，协程安全。"""
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
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)


def _is_allowed(ip: str) -> bool:
    return ip in _ALLOWED_INTERNAL_HOSTS


def _is_private_ip(ip: str) -> bool:
    for prefix in _PRIVATE_IP_PREFIXES:
        if ip.startswith(prefix):
            return True
    return False


def _resolve_and_validate(base_url: str) -> tuple[str, str, str, int]:
    """
    解析 baseUrl → 校验全部解析到的 IP。

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

    # IP 字面量 → 直接校验
    ipv4_match = re.match(r"^(\d{1,3}\.){3}\d{1,3}$", hostname)
    if ipv4_match:
        if _is_allowed(hostname):
            return hostname, hostname, scheme, port
        if _is_private_ip(hostname):
            _raise_bad_url(
                f"baseUrl pointing to private network ({hostname}) is not allowed"
            )
        return hostname, hostname, scheme, port

    # 域名 → DN 解析全部 IP
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


def _build_base_request_url(base_url: str) -> str:
    """规范化 baseUrl，去掉尾部 /。"""
    return base_url.rstrip("/")


# ── 接口 ────────────────────────────────────────────

@router.post("/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest,
    user=Depends(get_current_user),
):
    ip, hostname, scheme, port = _resolve_and_validate(body.baseUrl)

    headers = {"Content-Type": "application/json"}
    if body.apiKey:
        headers["Authorization"] = f"Bearer {body.apiKey}"

    url = _build_base_request_url(body.baseUrl)

    with _dns_pin(hostname, ip, port):
        async with httpx.AsyncClient(
            timeout=60,
            follow_redirects=False,
        ) as client:
            try:
                res = await client.post(
                    f"{url}/chat/completions",
                    headers=headers,
                    json={
                        "model": body.model,
                        "messages": body.messages,
                        "stream": False,
                    },
                )
                data = res.json()
                if not res.is_success:
                    return UnifiedResponse(
                        code=res.status_code,
                        data=None,
                        msg=data.get("error", {}).get("message", str(res.status_code)),
                    )
                return UnifiedResponse(code=200, data=data, msg="ok")
            except httpx.RequestError as e:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Failed to reach AI provider: {e}",
                )


@router.post("/models/list")
async def models_list(
    body: ModelListRequest,
    user=Depends(get_current_user),
):
    ip, hostname, scheme, port = _resolve_and_validate(body.baseUrl)

    headers = {}
    if body.apiKey:
        headers["Authorization"] = f"Bearer {body.apiKey}"

    url = _build_base_request_url(body.baseUrl)

    with _dns_pin(hostname, ip, port):
        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=False,
        ) as client:
            try:
                res = await client.get(f"{url}/models", headers=headers)
                data = res.json()
                if not res.is_success:
                    return UnifiedResponse(
                        code=res.status_code,
                        data=None,
                        msg=data.get("error", {}).get("message", str(res.status_code)),
                    )
                models = data.get("data", data) if isinstance(data, dict) else data
                return UnifiedResponse(code=200, data=models, msg="ok")
            except httpx.RequestError as e:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Failed to reach AI provider: {e}",
                )
