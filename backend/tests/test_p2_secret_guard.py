"""
P2: 密钥占位符启动校验。

JWT_SECRET_KEY / ADMIN_PASSWORD 仍为 .env.example 的占位值时拒绝启动，
除非显式 ALLOW_INSECURE_SECRETS=true（本地调试逃生）。
"""

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_rejects_placeholder_jwt_secret():
    with pytest.raises(ValidationError, match="Insecure placeholder secrets"):
        Settings(JWT_SECRET_KEY="change-me-to-a-random-secret",
                 ADMIN_PASSWORD="real-pass")


def test_rejects_placeholder_admin_password():
    with pytest.raises(ValidationError, match="Insecure placeholder secrets"):
        Settings(JWT_SECRET_KEY="real-secret",
                 ADMIN_PASSWORD="change-me-to-a-strong-password")


def test_accepts_real_secrets():
    s = Settings(JWT_SECRET_KEY="a-real-random-secret",
                 ADMIN_PASSWORD="a-strong-password")
    assert s.JWT_SECRET_KEY == "a-real-random-secret"


def test_allow_insecure_secrets_bypass():
    """显式 ALLOW_INSECURE_SECRETS=true 时允许占位符（本地调试）。"""
    s = Settings(JWT_SECRET_KEY="change-me-to-a-random-secret",
                 ADMIN_PASSWORD="change-me-to-a-strong-password",
                 ALLOW_INSECURE_SECRETS=True)
    assert s.ALLOW_INSECURE_SECRETS is True
