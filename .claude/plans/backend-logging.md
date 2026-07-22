# 实施计划：后端日志系统规范化

## 决策（已确认）
- 底层：**stdlib logging**（零重构，沿用现有 `getLogger`）
- 输出：**仅控制台**（uvicorn 终端）
- 彩色：**要**（按级别上色，Windows 终端兼容）

## 诊断（问题根因）

1. **默认级别 `WARNING`，正常运行几乎没日志** -- `main.py:11` 非 DEBUG 只输出 WARNING+。启动/任务创建/生成完成这些 INFO 全看不到。要么全开 DEBUG（httpx/sqlalchemy 噪音淹没），要么全关。没有「可读 INFO 中间态」。**这是「乱且不清楚」的根因。**
2. **`[worker]` 前缀冗余** -- worker.py 每条手写 `[worker]`，但 format 已含 `%name`。其他模块没这毛病。
3. **`print` 混入** -- `base.py:129` `download_and_save` 用 print，绕过 logging。
4. **格式不统一** -- 大部分 f-string，唯独 `worker.py:464` 用 %-style；key=value 随手排版。
5. **覆盖不均** -- ai_proxy 的 SSRF 拦截**完全没日志**；worker 每次响应打 `headers={dict(...)}` 很冗长；crud 层定义 logger 从没用。
6. **uvicorn access log 噪音** -- 每个请求一行 INFO，淹没业务日志。

---

## 目标格式

```
13:24:01 INFO     main            Starting up (DEBUG=False)
13:24:01 INFO     main            Database initialized, admin ensured
13:24:01 INFO     worker          Worker started (max_concurrency=10, stuck_timeout=20min)
13:24:05 INFO     generate        task created id=abc123 type=image user=1 node=n4 prompt_len=42
13:24:05 INFO     worker          processing task=abc123 type=image
13:24:05 INFO     worker          image request task=abc123 endpoint=https://exellome.online/images/generations model=exellome-1 n=1
13:24:11 INFO     worker          image done task=abc123 took=6123ms
13:24:11 INFO     generate        task completed id=abc123
13:24:30 WARN     ai-proxy        ssrf blocked host=internal.svc ip=10.0.0.5
13:24:31 ERROR    worker          image failed task=abc123 err=HTTPError 502
```

要点：
- `时间 LEVEL[固定宽] 模块[左对齐 16] 消息` -- 视觉对齐，一眼定位
- 模块名取 `__name__` 末段（`app.services.worker` -> `worker`），去 `app.` 前缀
- 业务对象用固定字段名：`task=<id>` `user=<id>` `node=<id>`，全链路 grep 友好
- 耗时操作带 `took=Xms`
- 彩色：DEBUG 灰 / INFO 绿 / WARN 黄 / ERROR 红

---

## 新增依赖

**`colorama>=0.4`** -- Windows 终端彩色兼容的事实标准，纯 Python 无编译（~20KB）。`requirements.txt` 加一行。
> 零依赖替代方案：用 ANSI 转义码 + `sys.stdout.isatty()` 检测 + Windows 下 `ctypes` 启用 VT 处理。可行但 hacky，不推荐。如不想加依赖选这个。

---

## 级别策略

| 级别 | 用途 | 例 |
|---|---|---|
| **INFO** | 正常业务关键节点 | 登录成功、上传、任务创建/完成、生成请求/完成 |
| **DEBUG** | 高频诊断（默认不显示） | worker 轮询、SSE tick、缓存命中、任务领取 |
| **WARNING** | 可恢复异常 | 重试、登录失败、SSRF 拦截、zombie 清理 |
| **ERROR** | 失败 | 任务失败、超时、ffmpeg 崩溃 |

**默认级别 `WARNING` -> `INFO`**（最关键修复）。`DEBUG=true` 才看轮询噪音。新增 `LOG_LEVEL` 环境变量覆盖。

---

## 关键操作日志清单（按模块）

| 模块 | 操作 | 级别 | 备注 |
|---|---|---|---|
| **main** | 启动/DB初始化/worker启动/关闭 | INFO | 现有保留 |
| **auth** | 登录成功 | INFO | `login ok user=<name> id=<id>` |
| | 登录失败 | WARN | 加 reason 字段 |
| **canvas** | 项目保存 | DEBUG | 高频，降级 |
| **files** | 上传成功 | INFO | 保留 |
| | dedup 命中 | DEBUG | 高频降级 |
| | 截帧 | INFO | 保留 |
| **generate** | 任务创建/取消 | INFO | 保留 |
| | SSE 打开/结束 | DEBUG | 高频降级 |
| **worker** | 启动 | INFO | 保留 |
| | 领取任务 | DEBUG | 每2s，降级防刷屏 |
| | processing | INFO | 保留，去 `[worker]` |
| | image request | INFO | 去 `headers={...}` 冗长字段 |
| | image done/failed | INFO/ERROR | **加 took 耗时** |
| | retryable | WARN | 保留 |
| | zombie cleanup | WARN | 保留 |
| | bg_removal 各步 | INFO/ERROR | 补全 |
| **ai_proxy** | **SSRF 拦截** | **WARN** | **当前完全无日志，必须补** |
| | chat/models 转发 | DEBUG | 补，便于排查 |
| **media** | 缓存命中 | DEBUG | 降级 |
| | ffmpeg 失败/超时 | ERROR | 保留 |
| **providers/base** | download_and_save 失败 | WARN | **print -> logger** |

---

## 分阶段实施（4 个独立 commit）

### C1：日志基础设施
**新增 `app/logging_config.py`**：
- `setup_logging()`：根 logger 默认 INFO，`LOG_LEVEL` 覆盖
- 自定义 `ColorFormatter`：ANSI 彩色 + 对齐 format（时间/LEVEL/模块/消息）
- `colorama.init()` Windows 兼容
- 第三方库静默：httpx/httpcore/aiosqlite/sqlalchemy.engine -> WARNING
- **uvicorn access log 静默**（`uvicorn.access` -> WARNING），保留 `uvicorn.error`

**`main.py`**：删 `basicConfig`，改调 `setup_logging()`；加 `LOG_LEVEL` 到 `config.py`。

**`requirements.txt`**：加 `colorama>=0.4`。

验证：启动后能看到 INFO 启动日志且带色；access log 不再刷屏。

### C2：worker 日志清理
- 全部去 `[worker]` 前缀
- `image request` 去 `headers={dict(resp.headers)}`（改 DEBUG 或删）
- `image done/failed` 加 `took=Xms`（记录请求开始时间）
- 领取任务 INFO -> DEBUG
- `worker.py:464` 的 %-style 改 f-string 统一

验证：生成一次，日志干净对齐、有耗时、无冗长 headers。

### C3：补缺失日志 + 去 print
- **ai_proxy.py**：SSRF 拦截处（`_raise_bad_url` 调用点）加 `logger.warning("ssrf blocked host=.. ip=..")`；chat/models 转发加 DEBUG
- **base.py:129** `print` -> `logger.warning`
- crud 层的 `getLogger` 若仍不用则删除（避免误导）

验证：构造一个内网 baseUrl 请求，看到 `ssrf blocked` WARN；download 失败走 logger 不走 print。

### C4：其余模块级别微调
- canvas 保存 INFO->DEBUG、files dedup INFO->DEBUG、generate SSE INFO->DEBUG、media 缓存 INFO->DEBUG
- auth 登录失败加 reason

验证：默认运行只看业务关键流；`LOG_LEVEL=DEBUG` 看全量诊断。

---

## 验证步骤（整体）

1. `pip install colorama`，`cd backend && uvicorn app.main:app`
2. 启动：见彩色 INFO 启动序列，无 access log 刷屏
3. 登录/上传/生成各一次：见对齐的业务日志，生成带 `took` 耗时
4. `LOG_LEVEL=DEBUG` 重启：见轮询/SSE/缓存诊断日志
5. 构造内网 baseUrl 调 ai_proxy：见 `ssrf blocked` 黄色 WARN
6. grep `task=<某id>`：能串起该任务的创建->processing->request->done 完整链路
