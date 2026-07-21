from typing import Optional, Sequence

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.model_config import ModelChannel, ModelInfo


# ── Channel CRUD ─────────────────────────────────────────────────────


async def get_channels(db: AsyncSession, user_id: int) -> Sequence[ModelChannel]:
    """获取用户的所有频道（连带 models 预加载）。"""
    result = await db.execute(
        select(ModelChannel)
        .where(ModelChannel.user_id == user_id)
        .options(selectinload(ModelChannel.models))
        .order_by(ModelChannel.updated_at.desc())
    )
    return result.scalars().all()


async def get_channel(
    db: AsyncSession, channel_id: int, user_id: int
) -> Optional[ModelChannel]:
    """获取单个频道（带所有权检查）。"""
    result = await db.execute(
        select(ModelChannel).where(
            ModelChannel.id == channel_id, ModelChannel.user_id == user_id
        )
    )
    return result.scalar_one_or_none()


async def create_channel(
    db: AsyncSession, user_id: int, name: str, base_url: str, api_key: str
) -> ModelChannel:
    """创建频道。"""
    ch = ModelChannel(user_id=user_id, name=name, base_url=base_url, api_key=api_key)
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return ch


async def update_channel(
    db: AsyncSession,
    channel_id: int,
    user_id: int,
    name: Optional[str] = None,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[ModelChannel]:
    """更新频道字段。不存在的字段不修改。返回 None 表示未找到。"""
    ch = await get_channel(db, channel_id, user_id)
    if not ch:
        return None
    if name is not None:
        ch.name = name
    if base_url is not None:
        ch.base_url = base_url
    if api_key is not None:
        ch.api_key = api_key
    await db.commit()
    return ch


async def delete_channel(
    db: AsyncSession, channel_id: int, user_id: int
) -> bool:
    """删除频道。返回 False 表示未找到。"""
    ch = await get_channel(db, channel_id, user_id)
    if not ch:
        return False
    await db.delete(ch)
    await db.commit()
    return True


# ── Model CRUD ───────────────────────────────────────────────────────


async def get_model(
    db: AsyncSession, model_id: int, channel_id: int
) -> Optional[ModelInfo]:
    """获取单个模型。"""
    result = await db.execute(
        select(ModelInfo).where(
            ModelInfo.id == model_id, ModelInfo.channel_id == channel_id
        )
    )
    return result.scalar_one_or_none()


async def add_model(
    db: AsyncSession, channel_id: int, name: str, capabilities: list[str]
) -> ModelInfo:
    """添加模型到频道。"""
    m = ModelInfo(channel_id=channel_id, name=name, capabilities=capabilities or [])
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return m


async def remove_model(
    db: AsyncSession, model_id: int, channel_id: int
) -> bool:
    """删除模型。返回 False 表示未找到。"""
    m = await get_model(db, model_id, channel_id)
    if not m:
        return False
    await db.delete(m)
    await db.commit()
    return True


async def set_models(
    db: AsyncSession, channel_id: int, models_data: list[dict]
) -> None:
    """全量替换频道下的模型列表（删除旧、插入新）。"""
    await db.execute(delete(ModelInfo).where(ModelInfo.channel_id == channel_id))
    for m_data in models_data:
        m = ModelInfo(
            channel_id=channel_id,
            name=m_data["name"],
            capabilities=m_data.get("capabilities", []),
        )
        db.add(m)
    await db.commit()


async def update_model_capabilities(
    db: AsyncSession, model_id: int, channel_id: int, capabilities: list[str]
) -> Optional[ModelInfo]:
    """更新模型能力列表。返回 None 表示未找到。"""
    m = await get_model(db, model_id, channel_id)
    if not m:
        return None
    m.capabilities = capabilities
    await db.commit()
    return m
