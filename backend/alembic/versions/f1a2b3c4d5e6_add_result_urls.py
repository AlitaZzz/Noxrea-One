"""add result_urls to generation_tasks

支持一次生成返回多张图：新增 result_urls(JSON) 列；
result_url 保留为兼容镜像（= 列表首张），不删除。

Revision ID: f1a2b3c4d5e6
Revises: e5f6a7b8c9d0
"""
from alembic import op
import sqlalchemy as sa


revision = "f1a2b3c4d5e6"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("generation_tasks") as batch_op:
        batch_op.add_column(sa.Column("result_urls", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("generation_tasks") as batch_op:
        batch_op.drop_column("result_urls")
