"""
背景移除推理服务 — 独立的 FPU 密集型图片处理服务。

架构原则：无状态、不联网、不认识数据库。
纯函数式图片处理黑盒：输入图片字节，输出图片字节。
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import httpx  # noqa: F401 — kept for forward compatibility
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, status, Depends
from fastapi.responses import Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic_settings import BaseSettings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("inference")


# ── Settings ──────────────────────────────────────────────────────

class Settings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    API_KEY: str = ""
    HOST: str = "0.0.0.0"
    PORT: int = 8100


settings = Settings()

# ── Auth ──────────────────────────────────────────────────────────

security = HTTPBearer(auto_error=False)


def verify_api_key(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    """Verify the API key from X-API-Key header or Bearer token."""
    if not settings.API_KEY:
        # No key configured = allow all (dev mode)
        return True
    # Check X-API-Key header via HTTPBearer
    key = credentials.credentials if credentials else ""
    if key == settings.API_KEY:
        return True
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")


# ── Model manager ─────────────────────────────────────────────────

models: dict[str, any] = {}
_semaphore = asyncio.Semaphore(2)


def load_models():
    """Load all models into the global models dict."""
    logger.info("Loading rembg model (u2net)...")
    from rembg import new_session
    models["rembg"] = new_session("u2net")
    logger.info("rembg model loaded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Inference service starting...")
    load_models()
    yield
    models.clear()
    logger.info("Inference service stopped")


# ── App ───────────────────────────────────────────────────────────

app = FastAPI(
    title="Noxrea AI Canvas — Inference Service",
    version="1.0.0",
    lifespan=lifespan,
)


# ── Routes ────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    return {"status": "ok", "models": list(models.keys())}


@app.post("/process/bg-removal")
async def bg_removal(
    file: UploadFile = File(...),
    model: str = Form("rembg"),
    _auth=Depends(verify_api_key),
):
    """Remove background from an image using the specified model.

    Accepts multipart/form-data with:
      - file: the image to process
      - model: model name (default "rembg", currently the only supported value)

    Returns image/png with transparent background.
    """
    if model not in models:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown model '{model}'. Available: {list(models.keys())}",
        )

    # Validate content type
    content_type = file.content_type or ""
    if not content_type.startswith("image/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only image files are supported",
        )

    # Read input image
    input_bytes = await file.read()
    if not input_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file",
        )

    # Process with semaphore to limit concurrent CPU load
    try:
        async with _semaphore:
            output_bytes = await asyncio.to_thread(_remove_bg, input_bytes, model)
    except Exception as e:
        logger.error(f"bg_removal failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Image processing failed: {str(e)[:200]}",
        )

    return Response(content=output_bytes, media_type="image/png")


def _remove_bg(input_bytes: bytes, model_name: str) -> bytes:
    """Synchronous rembg call — runs in thread pool via asyncio.to_thread."""
    from rembg import remove as rembg_remove

    session = models[model_name]
    output = rembg_remove(input_bytes, session=session)
    return output
