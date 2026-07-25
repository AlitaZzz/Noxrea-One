"""修复 config 中 params/endpoints/body 被存为字符串而非对象的问题

原迁移 e7c2cffcf8dc 使用 json_object() 拼接时，
旧列 (parameter_mapping/endpoint_mapping/override_json) 的 JSON 字符串
被当作普通文本嵌入，导致子字段值为字符串。

本迁移将字符串值用 json() 重新解析为对象。

Revision ID: a1b2c3d4e5f7
Revises: e7c2cffcf8dc
Create Date: 2026-07-25 12:47:00.000000
"""
from typing import Sequence, Union

from alembic import op


revision: str = "a1b2c3d4e5f7"
down_revision: Union[str, None] = "e7c2cffcf8dc"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """将 config 中字符串类型的 params/endpoints/body 重新解析为对象。

    对每一行，检查 json_type 是否为 'text'：
    - 是 → 用 json(json_extract(...)) 将字符串解析为对象
    - 否 → 保留原值（json_extract 直接提取）
    - NULL → 写回 '{}'
    """
    op.execute("""
        UPDATE model_channels
        SET config = json_object(
            'params',
            CASE
                WHEN json_type(config, '$.params') = 'text'
                    THEN json(json_extract(config, '$.params'))
                WHEN json_extract(config, '$.params') IS NULL
                    THEN json('{}')
                ELSE json_extract(config, '$.params')
            END,
            'endpoints',
            CASE
                WHEN json_type(config, '$.endpoints') = 'text'
                    THEN json(json_extract(config, '$.endpoints'))
                WHEN json_extract(config, '$.endpoints') IS NULL
                    THEN json('{}')
                ELSE json_extract(config, '$.endpoints')
            END,
            'body',
            CASE
                WHEN json_type(config, '$.body') = 'text'
                    THEN json(json_extract(config, '$.body'))
                WHEN json_extract(config, '$.body') IS NULL
                    THEN json('{}')
                ELSE json_extract(config, '$.body')
            END
        )
        WHERE config IS NOT NULL
    """)


def downgrade() -> None:
    """无需回滚 — 对象→字符串退化无意义"""
    pass
