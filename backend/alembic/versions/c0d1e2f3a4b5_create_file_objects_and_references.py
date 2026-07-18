"""create file_objects and file_references tables

Revision ID: c0d1e2f3a4b5
Revises: a1b2c3d4e5f6
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision = "c0d1e2f3a4b5"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 清理旧表（ref_count 版本已废弃）
    op.execute("DROP TABLE IF EXISTS file_objects")
    op.execute("DROP TABLE IF EXISTS file_references")

    op.create_table(
        "file_objects",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("hash", sa.String(64), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("mime_type", sa.String(100), nullable=False, server_default=""),
        sa.Column("ext", sa.String(10), nullable=False, server_default=""),
        sa.Column("source", sa.String(20), nullable=False, server_default="unknown"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("user_id", "hash"),
    )
    op.create_table(
        "file_references",
        sa.Column("id", sa.Integer(), autoincrement=True),
        sa.Column("file_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("ref_type", sa.String(20), nullable=False),
        sa.Column("ref_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("file_hash", "user_id", "ref_type", "ref_id", name="uq_file_ref"),
    )
    op.create_index("idx_fr_hash_user", "file_references", ["file_hash", "user_id"])
    op.create_index("idx_fr_type_id", "file_references", ["ref_type", "ref_id"])


def downgrade() -> None:
    op.drop_table("file_references")
    op.drop_table("file_objects")
