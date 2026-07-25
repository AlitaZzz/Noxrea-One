"""将 model_channels 的 parameter_mapping/endpoint_mapping/override_json 合并为单一 config 列

config 列已由 SQLAlchemy create_all 自动添加，本迁移仅负责数据合并并清理旧列。

Revision ID: e7c2cffcf8dc
Revises: f2a3b4c5d6e7
Create Date: 2026-07-25 11:34:07.403444
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e7c2cffcf8dc"
down_revision: Union[str, None] = "f2a3b4c5d6e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. 将旧 3 列数据合并写入 config
    op.execute(
        """
        UPDATE model_channels
        SET config = json_object(
            'params',    COALESCE(parameter_mapping, '{}'),
            'endpoints', COALESCE(endpoint_mapping, '{}'),
            'body',      COALESCE(override_json, '{}')
        )
        """
    )

    # 2. 删除旧 3 列
    op.execute("ALTER TABLE model_channels DROP COLUMN parameter_mapping")
    op.execute("ALTER TABLE model_channels DROP COLUMN endpoint_mapping")
    op.execute("ALTER TABLE model_channels DROP COLUMN override_json")


def downgrade() -> None:
    # 还原：拆回 3 列
    op.add_column(
        "model_channels",
        sa.Column("parameter_mapping", sa.JSON(), nullable=True),
    )
    op.add_column(
        "model_channels",
        sa.Column("endpoint_mapping", sa.JSON(), nullable=True),
    )
    op.add_column(
        "model_channels",
        sa.Column("override_json", sa.JSON(), nullable=True),
    )

    op.execute(
        """
        UPDATE model_channels
        SET parameter_mapping = json_extract(config, '$.params'),
            endpoint_mapping  = json_extract(config, '$.endpoints'),
            override_json     = json_extract(config, '$.body')
        """
    )

    op.execute("ALTER TABLE model_channels DROP COLUMN config")
