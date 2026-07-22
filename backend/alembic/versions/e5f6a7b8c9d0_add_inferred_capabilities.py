"""add inferred_capabilities to model_infos

Revision ID: e5f6a7b8c9d0
Revises: c0d1e2f3a4b5
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "c0d1e2f3a4b5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "model_infos",
        sa.Column("inferred_capabilities", sa.JSON(), server_default="[]", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("model_infos", "inferred_capabilities")
