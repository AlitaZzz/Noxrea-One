"""extend generation_tasks.type column from String(10) to String(30)

Revision ID: a1b2c3d4e5f6
Revises: d4cf9a7e2b12
Create Date: 2026-07-17

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "d4cf9a7e2b12"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("generation_tasks") as batch_op:
        batch_op.alter_column(
            "type",
            type_=sa.String(30),
            existing_type=sa.String(10),
            nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("generation_tasks") as batch_op:
        batch_op.alter_column(
            "type",
            type_=sa.String(10),
            existing_type=sa.String(30),
            nullable=False,
        )
