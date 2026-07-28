"""drop result_url from generation_tasks

result_url 是 result_urls[0] 的冗余镜像，全链路已统一使用 result_urls。
此迁移删除 result_url 列。

Revision ID: b3c4d5e6f7a8
Revises: a1b2c3d4e5f7
"""
from alembic import op
import sqlalchemy as sa


revision = "b3c4d5e6f7a8"
down_revision = "a1b2c3d4e5f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("generation_tasks") as batch_op:
        batch_op.drop_column("result_url")


def downgrade() -> None:
    with op.batch_alter_table("generation_tasks") as batch_op:
        batch_op.add_column(sa.Column("result_url", sa.Text(), nullable=True))
