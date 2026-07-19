"""技能自动发现 — 扫描 skills/ 目录，找到所有 BaseSkill 子类。"""

import importlib
import logging
import pkgutil
from typing import Type

from app.skill_base import BaseSkill, SkillError

logger = logging.getLogger(__name__)


def _all_subclasses(cls: Type[BaseSkill]) -> list[Type[BaseSkill]]:
    """递归找到 cls 的所有具体（非抽象）子类。"""
    result: list[Type[BaseSkill]] = []
    for sub in cls.__subclasses__():
        if not getattr(sub, '__abstractmethods__', None):
            result.append(sub)
        result.extend(_all_subclasses(sub))
    return result


def discover_skills() -> dict[str, BaseSkill]:
    """扫描 skills/ 目录，实例化所有已发现的 BaseSkill 子类。

    返回 {skill.name: skill_instance} 字典。重复 skill.name 会报错。
    """
    # 1. 扫描 skills/ 目录，导入所有 .py 模块（跳过 __init__ 和 base）
    from app import skills as skills_pkg

    for module_info in pkgutil.iter_modules(skills_pkg.__path__, prefix="app.skills."):
        if module_info.ispkg:
            continue
        try:
            importlib.import_module(module_info.name)
            logger.info(f"已导入技能模块: {module_info.name}")
        except Exception as e:
            logger.warning(f"导入技能模块失败 {module_info.name}: {e}")

    # 2. 找到 BaseSkill 的所有具体子类
    skill_classes = _all_subclasses(BaseSkill)
    logger.info(f"发现 {len(skill_classes)} 个技能类")

    # 3. 实例化 + 校验
    skills: dict[str, BaseSkill] = {}
    for cls in skill_classes:
        instance = cls()
        name = instance.name

        if not name:
            raise SkillError(f"技能类 {cls.__name__} 必须定义非空的 'name'")
        if name in skills:
            raise SkillError(
                f"技能名 '{name}' 重复: {cls.__name__} 和 "
                f"{type(skills[name]).__name__}"
            )

        skills[name] = instance
        logger.info(f"已注册技能: {name} ({cls.__name__})")

    return skills
