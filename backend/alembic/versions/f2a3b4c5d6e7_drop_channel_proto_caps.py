"""drop protocol and capabilities from model_channels

Revision ID: f2a3b4c5d6e7
Revises: f1a2b3c4d5e6
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f2a3b4c5d6e7"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE model_channels DROP COLUMN protocol")
    op.execute("ALTER TABLE model_channels DROP COLUMN capabilities")


def downgrade() -> None:
    op.add_column(
        "model_channels", sa.Column("protocol", sa.String(30), nullable=True)
    )
    op.add_column(
        "model_channels", sa.Column("capabilities", sa.JSON(), nullable=True)
    )
