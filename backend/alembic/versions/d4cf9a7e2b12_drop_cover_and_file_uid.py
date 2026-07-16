"""drop cover from asset_items, file_uid from users

Revision ID: d4cf9a7e2b12
Revises: 8ca19dcee7b2
Create Date: 2026-07-15

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d4cf9a7e2b12"
down_revision: Union[str, None] = "8ca19dcee7b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE asset_items DROP COLUMN cover")
    op.execute("ALTER TABLE users DROP COLUMN file_uid")


def downgrade() -> None:
    op.add_column("asset_items", sa.Column("cover", sa.String(500), nullable=False, server_default=""))
    op.add_column("users", sa.Column("file_uid", sa.String(36), nullable=False, server_default=""))
