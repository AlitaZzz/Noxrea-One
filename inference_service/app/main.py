"""推理服务编排层 — lifespan、路由注册、health 检查。"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Depends, status, Request
from fastapi.responses import Response

from app.config import settings
from app.auth import verify_api_key
from app.model_manager import ModelManager
from app.registry import discover_skills
from app.skill_base import SkillError, SkillProcessingError

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("inference")

# 全局信号量，限制 CPU 并发
_semaphore = asyncio.Semaphore(settings.INFERENCE_CONCURRENCY)


# ── Lifespan ──────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("=" * 50)
    logger.info("推理服务启动中...")

    # 1. 发现所有技能
    skills = discover_skills()
    logger.info(f"已发现技能: {list(skills.keys())}")

    # 2. 收集所有技能需要的模型 key，注册到管理器（不加载）
    model_manager = ModelManager(settings)
    all_models: set[str] = set()
    for skill in skills.values():
        all_models.update(skill.required_models)
    for key in all_models:
        model_manager.register(key)

    # 3. 给每个技能绑定模型获取函数（技能调用时才懒加载）
    for skill in skills.values():
        skill.bind_loader(model_manager.get)
        # model_manager.get(key) 天然支持懒加载 + LRU，多模型技能也直接复用

    # 4. 可选：预加载所有模型（MODEL_PRELOAD=True 时）
    if settings.MODEL_PRELOAD:
        logger.info("MODEL_PRELOAD=True，启动时加载所有模型...")
        model_manager.preload_all()

    # 5. 存入 app.state 供路由使用
    app.state.skills = skills
    app.state.model_manager = model_manager

    loaded = model_manager.list_loaded()
    logger.info(f"服务就绪 — 技能: {list(skills.keys())}，"
                f"显存中模型: {loaded or '无（首次调用时懒加载）'}，"
                f"并发上限: {settings.INFERENCE_CONCURRENCY}")
    logger.info("=" * 50)
    yield

    # 关闭
    model_manager.unload_all()
    logger.info("推理服务已停止")


# ── App ──────────────────────────────────────────────────────


app = FastAPI(
    title="Noxrea AI Canvas — Inference Service",
    version="2.0.0",
    lifespan=lifespan,
)


# ── Routes ───────────────────────────────────────────────────


@app.get("/health")
async def health(request: Request):
    """健康检查 — 返回服务状态和已注册的技能列表。"""
    skill_names = list(request.app.state.skills.keys()) if hasattr(request.app.state, "skills") else []
    return {"status": "ok", "models": skill_names}


@app.post("/process/{skill_name}")
async def process(
    skill_name: str,
    file: UploadFile = File(...),
    request: Request = None,
    _auth=Depends(verify_api_key),
):
    """统一的技能调用入口。

    路径参数:
        skill_name — 技能标识（如 "bg-removal"）
    表单字段:
        file — 输入图片
        其他字段 — 透传给技能的 process(**kwargs)
    """
    # 1. 查技能
    skills: dict = request.app.state.skills
    if skill_name not in skills:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"未知技能 '{skill_name}'。可用: {list(skills.keys())}",
        )

    skill = skills[skill_name]

    # 2. 读输入字节
    input_bytes = await file.read()

    # 3. 校验
    try:
        skill.validate(file.content_type, len(input_bytes))
    except SkillError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    # 4. 提取额外表单字段（排除 file），透传给 skill.process()
    form = await request.form()
    extra_kwargs = {k: v for k, v in form.items() if k != "file"}

    # 5. 处理（信号量 + 线程池）
    model_manager = request.app.state.model_manager
    try:
        async with _semaphore:
            output_bytes = await asyncio.to_thread(
                skill.process, input_bytes, **extra_kwargs
            )
    except SkillError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except SkillProcessingError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )
    except Exception as e:
        logger.error(f"技能 '{skill_name}' 处理失败: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"图片处理失败: {str(e)[:200]}",
        )
    finally:
        # 用完即卸：释放显存给其他模型/进程
        if settings.UNLOAD_AFTER_USE:
            for model_key in skill.required_models:
                model_manager.unload(model_key)

    # 6. 返回
    return Response(content=output_bytes, media_type=skill.returns_content_type)
