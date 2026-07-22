"""
刷新 OpenRouter 模型能力数据（用于模型能力推断的本地参考库）。

用法：
    python backend/scripts/fetch_model_db.py

输出：backend/app/data/openrouter_models.json
该文件被 app.services.model_capabilities 在启动时加载，用于按模型名推断能力。
数据不入库，仅本地缓存；已被 .gitignore 忽略，需用时手动刷新。
"""

import json
import os
import sys
import urllib.request

TARGET = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "app", "data", "openrouter_models.json",
)
URL = "https://openrouter.ai/api/v1/models"


def main() -> int:
    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    print(f"下载 OpenRouter 模型列表: {URL}")
    req = urllib.request.Request(URL, headers={"User-Agent": "Noxrea-AI-Canvas"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except Exception as e:  # noqa: BLE001
        print(f"下载失败: {e}", file=sys.stderr)
        return 1

    data = json.loads(raw)
    models = data.get("data", [])
    print(f"共 {len(models)} 个模型，写入 {TARGET}")
    with open(TARGET, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
