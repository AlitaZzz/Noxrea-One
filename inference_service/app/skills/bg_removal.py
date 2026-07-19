"""背景移除技能 — 基于 BiRefNet_HR（高分辨率变体）。

BiRefNet 的 HR 版本，在 2048×2048 分辨率上训练，适合高分辨率图片抠图，MIT 协议可商用。

精度控制：
    precision=fast     → 1024×1024，快
    precision=standard → 2048×2048，默认，高精度
    precision=high     → 2048×2048（同 standard，HR 已是最优）
"""

import io
import torch
from PIL import Image
from torchvision import transforms

from app.config import settings
from app.skill_base import BaseSkill

_MEAN = [0.485, 0.456, 0.406]
_STD = [0.229, 0.224, 0.225]

# HR 模型原生 2048，精度选项做适当降采样
_PRECISION_CONFIG: dict[str, tuple[tuple[int, int], str]] = {
    "fast":     ((1024, 1024), "Fast"),
    "standard": ((2048, 2048), "Standard"),
    "high":     ((2048, 2048), "High"),
}


class BgRemovalSkill(BaseSkill):
    name = "bg-removal"
    display_name = "Background Removal (BiRefNet-HR)"
    required_models = ["birefnet-hr"]
    accepted_content_types = ["image/"]
    returns_content_type = "image/png"

    _transforms: dict[str, object] = {}  # 按精度缓存 transform

    def _get_transform(self, precision: str):
        """按精度获取/创建 transform（缓存避免重复创建）。"""
        if precision not in self._transforms:
            size, _label = _PRECISION_CONFIG[precision]
            self._transforms[precision] = transforms.Compose([
                transforms.Resize(size),
                transforms.ToTensor(),
                transforms.Normalize(_MEAN, _STD),
            ])
        return self._transforms[precision]

    def process(self, input_bytes: bytes, **kwargs) -> bytes:
        """移除图片背景，返回 RGBA PNG 字节。

        额外表单参数：
            precision — 精度级别: fast | standard | high（默认 standard）
        """
        model = self._get_model("birefnet-hr")  # 懒加载：首次调用时加载到显存
        device = next(model.parameters()).device

        # 精度：优先取请求参数，否则用全局配置
        precision = kwargs.get("precision", settings.BG_REMOVAL_PRECISION)
        if precision not in _PRECISION_CONFIG:
            precision = "standard"
        input_size, _label = _PRECISION_CONFIG[precision]

        # 1. 解码输入图片
        original = Image.open(io.BytesIO(input_bytes)).convert("RGB")
        orig_size = original.size

        # 2. 按精度预处理 → tensor
        transform_fn = self._get_transform(precision)
        tensor = transform_fn(original).unsqueeze(0).to(device)

        # 3. 推理（无梯度，省显存）
        with torch.inference_mode():
            preds = model(tensor)[-1].sigmoid().cpu()
        mask_tensor = preds[0].squeeze()

        # 4. mask 恢复到原始分辨率
        mask_pil = transforms.ToPILImage()(mask_tensor)
        mask_pil = mask_pil.resize(orig_size, Image.LANCZOS)

        # 5. 合成 RGBA
        result = original.convert("RGBA")
        result.putalpha(mask_pil)

        # 6. 编码输出
        buf = io.BytesIO()
        result.save(buf, format="PNG")
        return buf.getvalue()
