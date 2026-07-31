# Token 使用规则

Claude Code 的上下文窗口有限，以下规则旨在减少每次会话的 token 消耗，避免上下文被不必要的大段输出撑满。

## 大文件处理

- **优先用 Grep 定位**：需要查找特定内容时，先用 Grep 搜索关键词定位到行，而不是直接 Read 整个文件
- **Read 只读片段**：确认目标行号后，用 `offset` + `limit` 参数只读取需要的片段，避免读完整文件
- **Glob 缩小范围**：用 Glob 时附加 `path` 参数限制定位到特定目录，不匹配整个项目

```bash
# ✅ 好：先 grep 定位，再 offset/limit 只读相关片段
grep -n "saveManager" web/src/stores/ --include="*.ts"
# 然后 Read file_path + offset + limit

# ❌ 差：不找定位直接读，大文件（如 canvas-store.ts >500 行）一次拉满
```

## Bash 输出长度控制

执行预计输出较长的命令时，**默认追加过滤管道**：

- 文件列表 → `| head -30` 或 `| sort` 后取首尾
- 搜索结果 → 利用 `head_limit` 参数或 `| head -20`
- 日志/构建输出 → `| tail -20` 或 `| grep -E "error|warning" -i`

如果确实需要完整输出（如排查 CI 构建步骤），在命令中明确说明原因。

## 文件写入

- 优先用 Edit 工具创建/编辑文件，而不是通过 Bash 的 echo/cat 写入
- 增量修改用 Edit 工具做精确替换，不重写整个文件
