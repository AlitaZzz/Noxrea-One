# Noxrea AI Canvas — 背景移除推理服务

独立推理服务，使用 rembg 进行图片背景移除（抠图）。

## 快速启动

```bash
cd inference_service
pip install -r requirements.txt
# 首次启动会自动下载 u2net.onnx (~176MB) 到 ~/.u2net/
# 模型下载完成后自动缓存，后续启动秒级加载
uvicorn main:app --port 8100 --reload
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `API_KEY` | 调用认证 Key（必须设置） | — |
| `HOST` | 监听地址 | `0.0.0.0` |
| `PORT` | 监听端口 | `8100` |

## 接口

### `GET /health`
健康检查，返回已加载的模型列表。

```json
{ "status": "ok", "models": ["rembg"] }
```

### `POST /process/bg-removal`
背景移除。接受 `multipart/form-data`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | image | 输入图片 |
| `model` | string | 使用的模型（当前仅支持 `"rembg"`） |

返回 `image/png`，背景已移除。

```bash
curl -X POST http://localhost:8100/process/bg-removal \
  -H "X-API-Key: your-key" \
  -F "file=@input.jpg" \
  -o output.png
```

## 架构说明

- 无状态、不联网（除首次下载模型外）、不认识数据库
- 仅通过 HTTP 被主 API 的 Worker 调用，不对外暴露
- 并发上限为 2 个同时处理请求，超出排队等待
