# 架构约定细节

> 本文件存放画布保存机制、生命周期、常见 Bug 模式等偏细节的架构约定。
> CLAUDE.md 中只保留一行引用，避免每次会话占用过多上下文。

---

## 画布保存机制

所有画布状态变化最终都要经过 SaveManager（`frontend/src/lib/save-manager.ts`），全局单例 `saveManager`。

### 触发方式

| 操作类型 | 方法 | 合并窗口 | 典型场景 |
|---|---|---|---|
| 离散操作 | `markDirtyImmediate()` | ~100ms | 增删节点、编组/解组、粘贴、连线创建/删除 |
| 连续操作 | `markDirty()` | ~2s trailing | 拖拽节点、文本输入、缩放/平移画布 |
| 不做操作 | 不调用 | — | 纯 UI 选择状态变化（`select` 类型） |

**关键原则：**
- 新增涉及节点数据持久化的功能时，必须**明确判断该操作是"离散"还是"连续"**，并对应调用正确的方法
- 不要依赖其他调用"顺带"触发保存（这是本项目反复踩过的坑）
- 内部实现：`setDirty()` 先把内存状态同步到 projectStore，再启动 timer；`flushSave()` 清除 timer 立即保存

### 生命周期兜底

```
beforeunload / pagehide → flushOnUnload()    → keepalive fetch
visibilitychange (hidden) → flushOnUnload()  → keepalive fetch
组件卸载 (useEffect cleanup) → flushOnUnload() → keepalive fetch
```

- `flushOnUnload()` 用 `keepalive: true` 的 fetch，不重试，不改变内部状态
- **不要用 popstate 拦截浏览器回退**（拦不住），依赖组件卸载的 useEffect cleanup 兜底

### 查询保存状态

```ts
saveManager.status  // → { dirty: boolean, saving: boolean }
```

---

## 常见 Bug 模式

### 1. useEffect cleanup ≠ 组件真正卸载

`useEffect` 依赖数组变化触发 re-run 时，cleanup 函数也会执行，但这**不是**组件卸载。两者容易混淆。

**应对：** 用 ref 标记是否真正卸载，或者用独立的空依赖 effect 来注册真正的卸载逻辑。

```ts
// ❌ 错误：依赖变化（如 projectId 变化）会误触发"卸载保存"
useEffect(() => {
  return () => flushOnUnload();  // 依赖变化时也会执行！
}, [projectId]);

// ✅ 正确：只在组件真正卸载时保存
useEffect(() => {
  return () => flushOnUnload();
}, []);
```

### 2. 闭包捕获过期数据

组件本地闭包捕获的旧数据（如异步回调里用了过期的 props 快照）容易覆盖 store 里的最新数据。

**应对：** 涉及异步更新节点数据时，**从 store 实时读取**，不要用闭包变量。

```ts
// ❌ 错误：闭包捕获了旧的 nodes 快照
setTimeout(() => {
  updateNode(nodeId, { ...node.data, label: newLabel }); // node 可能已过期
}, 1000);

// ✅ 正确：从 store 实时读取
setTimeout(() => {
  const current = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
  if (current) updateNode(nodeId, { ...current.data, label: newLabel });
}, 1000);
```

### 3. store 读写不走闭包

Zustand store 的 `getState()` 方法可以在组件外和异步回调中获取最新状态，不受闭包影响。这是项目中广泛使用的模式。

---

## SSRF 防护

新增网络请求转发功能时，参考 `backend/app/routers/ai_proxy.py` 中的实现：

1. **DNS Pinning**：请求前解析域名到 IP 并锁定 DNS（`_dns_pin` 上下文管理器），防御 DNS rebinding 攻击
2. **私网 IP 检测**：检查解析到的所有 IP 是否属于内网段（10.\*, 192.168.\*, 172.16-31.\*, 127.\*, fc00:/fd00: 等）
3. **Hostname 黑名单**：禁止 localhost、localhost.localdomain、metadata.google.internal 等
4. **内网白名单**：通过 `ALLOWED_INTERNAL_HOSTS` 环境变量配置例外
5. **关闭重定向**：`follow_redirects=False` 防止跳转到内网地址

### 新增接口注意事项

- 所有 AI 代理接口需 `Depends(get_current_user)` 鉴权
- 使用 `httpx.AsyncClient` 而非 requests
- 设置合理的 timeout

---

## 代码规范

### 编辑与阅读习惯

- **优先编辑现有文件，而非重写整个文件**：用 Edit/str_replace 做精确改动，不要用 Write 整体覆盖
- **除非文件被修改过，否则不要重复完整读取已经读过的文件**：与 [docs/claude-code-workflow.md](claude-code-workflow.md) 的省 token 规则呼应，避免重复消耗上下文

### 代码结构

- **嵌套逻辑不超过 4 层**：超过时优先考虑提前 `return`（guard clause）或拆分函数，而不是继续往里嵌套
- **新建文件尽量控制在 400 行以内**：这是对*新建*文件的建议，不是强制门槛
- **已有的大文件不强制拆分**：例如 `InfiniteCanvas.tsx`（目前约 920 行，架构审查已记录在案）暂不拆分，因为拆分本身是一次不小的重构，容易引入回归。**除非我明确要求做这个重构，否则不要在日常改动中主动提议拆分**，避免打断当前任务节奏

### 沟通与输出

- **不要为了"简洁"而省略改动说明**：每次改动需要清楚说明改了什么、为什么改，涉及多文件改动时给出 diff 摘要——这是本项目已经磨合出来的协作方式，比通用的"输出从简"规则优先级更高
- 可以省略的是无关的寒暄、重复确认、以及已经说过的内容重复陈述
