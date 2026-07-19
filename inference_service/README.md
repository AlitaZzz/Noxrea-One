# Noxrea AI Canvas — 推理服务

独立推理服务，提供本地模型推理能力。采用插件式技能架构，新增技能只需添加一个 `.py` 文件。

## 快速启动

```bash
cd inference_service
pip install -r requirements.txt

# 首次启动会自动下载 RMBG-2.0 模型（约 400MB，默认走魔塔）
# 如果魔塔不可用会自动降级到 HF 镜像 → HuggingFace 官方
uvicorn main:app --port 8100 --reload
```

## 目录结构

```
inference_service/
├── main.py                  # 入口（from app.main import app）
├── app/
│   ├── main.py              # 编排层：lifespan、路由、health
│   ├── config.py            # 配置（从 .env 读取）
│   ├── auth.py              # API Key 鉴权
│   ├── model_manager.py     # 模型管理 + 多源降级加载
│   ├── skill_base.py        # 技能基类
│   ├── registry.py          # 技能自动发现
│   └── skills/
│       └── bg_removal.py    # 背景移除技能（RMBG-2.0）
├── requirements.txt
├── .env
└── README.md
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `API_KEY` | 调用认证 Key | —（空=不鉴权） |
| `MODEL_CACHE_DIR` | 模型缓存目录 | `./models` |
| `DOWNLOAD_SOURCE` | 下载源：`modelscope`（魔塔→HF镜像→官方降级）或 `huggingface` | `modelscope` |
| `HF_TOKEN` | HuggingFace 访问令牌（走魔塔时不需要） | — |
| `INFERENCE_CONCURRENCY` | 并发处理上限 | `2` |
| `LOG_LEVEL` | 日志级别 | `INFO` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `PORT` | 监听端口 | `8100` |

## 接口

### `GET /health`
健康检查，返回已注册的技能列表。

```json
{ "status": "ok", "models": ["bg-removal"] }
```

### `POST /process/{skill_name}`
统一的技能调用入口。接受 `multipart/form-data`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | image | 输入图片 |
| （其他） | — | 透传给技能的 `process()` |

#### `POST /process/bg-removal` — 背景移除

```bash
curl -X POST http://localhost:8100/process/bg-removal \
  -H "Authorization: Bearer your-key" \
  -F "file=@input.jpg" \
  -o output.png
```

返回 `image/png`（RGBA，背景已透明）。

## 模型降级链

`DOWNLOAD_SOURCE=modelscope`（默认）时，加载顺序：

1. **魔搭社区** (`AI-ModelScope/RMBG-2.0`) — 国内最快，无需 token
2. **HF 镜像** (`hf-mirror.com`) — 降级代理
3. **HuggingFace 官方** (`briaai/RMBG-2.0`) — 最后手段（需要 HF_TOKEN）

任一级成功即停止，全部失败才报错。

## 新增技能

只需在 `app/skills/` 下创建一个 `.py` 文件，继承 `BaseSkill`：

```python
from app.skill_base import BaseSkill

class MySkill(BaseSkill):
    name = "my-skill"
    required_models = ["my-model"]

    def process(self, input_bytes: bytes, **kwargs) -> bytes:
        model = self._models["my-model"]
        # ... 处理逻辑 ...
        return output_bytes
```

然后在 `model_manager.py` 的 `_init_model()` 和 `_MODEL_ID_MAP` 中注册模型即可。重启后 `POST /process/my-skill` 自动可用。

## 架构说明

- 无状态、不联网（除首次下载模型外）、不认识数据库
- 仅通过 HTTP 被主 API 的 Worker 调用，不对外暴露
- 并发上限可通过 `INFERENCE_CONCURRENCY` 配置
- 技能自动发现：任何 `skills/` 下继承 `BaseSkill` 的类都会在启动时被注册
