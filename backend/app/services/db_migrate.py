"""
db_migrate.py — 启动期幂等的轻量 schema 迁移。

仅用于开发/兜底：Base.metadata.create_all 只建「缺失的表」，不会对已存在的表
追加新列。模型演进（如新增 capability/protocol/model/upstream_task_id 等列）后，
旧库会因缺少列而报 OperationalError。这里在启动时检测并 ALTER 补列。

生产环境仍应以 alembic 迁移为唯一结构变更入口；本模块作为开发兜底与容错。
"""

import logging

from sqlalchemy import text as _sql

logger = logging.getLogger(__name__)

# 表 -> [(列名, 安全的 DDL 类型), ...]
# 仅包含「可 NULL、无默认值约束」的新列，SQLite 才允许 ALTER ADD COLUMN。
_EXPECTED_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "generation_tasks": [
        ("capability", "VARCHAR(30)"),
        ("protocol", "VARCHAR(30)"),
        ("model", "VARCHAR(200)"),
        ("upstream_task_id", "VARCHAR(200)"),
        ("result_text", "TEXT"),
    ],
    "model_channels": [
        ("protocol", "VARCHAR(30)"),
        ("config", "JSON"),
    ],
}


async def ensure_schema_migrations(engine) -> None:
    """检测并补齐缺失的列（幂等，可重复执行）。

    通过 PRAGMA table_info 读取现有列，仅对缺少的列执行 ALTER TABLE ADD COLUMN。
    """
    async with engine.connect() as conn:
        for table, columns in _EXPECTED_COLUMNS.items():
            # 表可能尚未存在（全新库由 create_all 创建），跳过即可
            try:
                res = await conn.execute(_sql(f"PRAGMA table_info({table})"))
                existing = {row[1] for row in res.fetchall()}
            except Exception as e:  # 表不存在
                logger.warning(f"ensure_schema_migrations skip {table}: {e}")
                continue

            for col, col_type in columns:
                if col not in existing:
                    try:
                        await conn.execute(
                            _sql(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}")
                        )
                        await conn.commit()
                        logger.info(f"ensure_schema_migrations added column {table}.{col}")
                    except Exception as e:
                        logger.warning(
                            f"ensure_schema_migrations add {table}.{col} failed (ignored): {e}"
                        )
