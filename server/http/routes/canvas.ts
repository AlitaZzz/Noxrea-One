/**
 * 画布工程路由。
 * 处理画布工程的查询、创建、更新与删除等接口。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/http/middleware/auth";
import { canvasCreateSchema, canvasDeltaSchema, canvasUpdateSchema } from "@server/schemas/canvas";
import {
  getProjects,
  createProject,
  getProject,
  updateProject,
  updateProjectDelta,
  deleteProject,
  projectExists,
  CanvasRevisionConflictError,
  CanvasLeaseLostError,
  CanvasCoverUrlError,
} from "@server/crud/canvas";
import { ok, failCode } from "@server/core/response";
import { isValidId } from "@server/utils/id";
import { loadJson } from "@server/services/json-loader";
import { renderAngleTemplate } from "@server/services/canvas/angle-prompt";
import { renderLightingTemplate } from "@server/services/canvas/lighting-prompt";
import { createSseResponse } from "../sse";
import {
  broadcastToOthers,
  destroyRoom,
  joinCanvasRoom,
  leaveCanvasRoom,
  withProjectGate,
} from "@server/services/canvas/editor-lease";

const router = new Hono();

interface BilingualText {
  zh: string;
  en: string;
}

type PromptTarget = "image" | "text";

interface PromptTemplateEntry {
  id: string;
  kind: "preset" | "dynamic";
  target: PromptTarget;
  group?: string;
  label?: BilingualText;
  description?: BilingualText;
  order?: number;
  template: string;
}

interface PromptTemplateGroup {
  id: string;
  label: BilingualText;
  /** 菜单分列归属（从 1 起）：同列分组纵向堆叠，列按序从左到右排 */
  column: number;
  order: number;
}

// 文件 mtime 变化时由 json-loader 重新解析，两个接口共享同一份实时目录。
function loadPromptTemplateCatalog(): { groups: PromptTemplateGroup[]; entries: PromptTemplateEntry[] } {
  return loadJson<{ groups: PromptTemplateGroup[]; entries: PromptTemplateEntry[] }>("prompt-template.json");
}

// 生成面板 / 工具条共用可选目录，返回全部预设条目；
// target 差异由前端在 select 侧投影（filterCatalogByTarget），服务端不再分靶取数。
// 分组只保留含有当前条目的。动态插值项不进入列表。
// label / description 为内联双语，前端按当前语言在渲染期取值，语言切换即时生效。
router.get("/api/canvas/prompt-templates", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const catalog = loadPromptTemplateCatalog();
  const selectable = catalog.entries
    .filter((entry) => entry.kind === "preset")
    .sort((a, b) => a.order! - b.order!)
    .map(({ id, kind, target, group, label, description, order, template }) =>
      ({ id, kind, target, group, label, description, order, template }));
  const entryGroups = new Set(selectable.map((entry) => entry.group));
  const groups = [...catalog.groups]
    .filter((group) => entryGroups.has(group.id))
    .sort((a, b) => a.order - b.order);
  return c.json(ok({ groups, entries: selectable }));
});

router.get("/api/canvas/prompt-template", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const type = c.req.query("type");
  if (!type) return failCode(400, "canvas.missing_type_param");

  const entry = loadPromptTemplateCatalog().entries.find((item) => item.id === type);
  if (!entry) return failCode(404, "canvas.template_not_found", { type });

  let template = entry.template;
  if (type === "lighting") template = renderLightingTemplate(template, c.req.query());
  else if (type === "angle") template = renderAngleTemplate(template, c.req.query());
  return c.json(ok({ type, template }));
});

router.get("/api/canvas/projects", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const projects = await getProjects(auth.user.id);
  return c.json(ok(projects));
});

// POST /api/canvas/projects
router.post("/api/canvas/projects", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = canvasCreateSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const project = await createProject(auth.user.id, {
    name: parsed.data.name,
    canvasData: parsed.data.canvasData,
  });

  return c.json(ok(project));
});

// PUT /api/canvas/projects/:id
router.put("/api/canvas/projects/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = c.req.param("id");
  if (!isValidId(id)) return failCode(400, "canvas.invalid_project_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = canvasUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }
  // 版本校验只服务画布内容：带 canvasData 的保存必须携带 baseRevision + lease
  // （编辑权租约令牌），否则会绕过冲突检查直写；纯改名不参与版本判定，允许省略。
  if (
    parsed.data.canvasData !== undefined &&
    (parsed.data.baseRevision === undefined || parsed.data.lease === undefined)
  ) {
    return failCode(422, "common.invalid_request");
  }

  try {
    const project = await updateProject(id, auth.user.id, {
      name: parsed.data.name,
      canvasData: parsed.data.canvasData,
      coverUrl: parsed.data.coverUrl,
    }, {
      baseRevision: parsed.data.baseRevision,
      lease: parsed.data.lease,
    });
    if (!project) return failCode(404, "canvas.project_not_found");
    return c.json(ok(project));
  } catch (error) {
    // 409 携带当前 revision。租约有效期间服务端 revision 只因本页自己的写入
    // 前进，因此 409 结构上只可能来自租约失效（被其他页面实例接管）：
    // 前端无条件同步版本并进入过期态，不存在任何重试路径。
    // （revision 冲突分支是纵深防御，与租约失效同形收敛为同一语义。）
    if (error instanceof CanvasRevisionConflictError) {
      return failCode(409, "canvas.project_revision_conflict", {
        revision: error.currentRevision,
      });
    }
    // 租约失效但项目恰被删除（删除不校验租约的窄竞态）：无版本可回传，
    // 省略 ctx——前端按无版本过期处理，随后 SSE 重连 404 收敛为 missing
    if (error instanceof CanvasLeaseLostError) {
      return failCode(409, "canvas.project_revision_conflict",
        error.currentRevision !== null ? { revision: error.currentRevision } : undefined);
    }
    // 封面不是本站 /api/files/ 地址：无法登记引用账本（GC 会回收），直接拒绝
    if (error instanceof CanvasCoverUrlError) {
      return failCode(422, "common.invalid_request");
    }
    throw error;
  }

});

// PATCH /api/canvas/projects/:id：合并画布增量（仅卸载 keepalive 使用）
router.patch("/api/canvas/projects/:id", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const id = c.req.param("id");
  if (!isValidId(id)) return failCode(400, "canvas.invalid_project_id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }
  const parsed = canvasDeltaSchema.safeParse(body);
  if (!parsed.success) return failCode(422, "common.invalid_request");
  try {
    const project = await updateProjectDelta(id, auth.user.id, parsed.data, {
      baseRevision: parsed.data.baseRevision,
      lease: parsed.data.lease,
    });
    if (!project) return failCode(404, "canvas.project_not_found");
    return c.json(ok(project));
  } catch (error) {
    if (error instanceof CanvasRevisionConflictError) {
      return failCode(409, "canvas.project_revision_conflict", { revision: error.currentRevision });
    }
    if (error instanceof CanvasLeaseLostError) {
      return failCode(409, "canvas.project_revision_conflict",
        error.currentRevision !== null ? { revision: error.currentRevision } : undefined);
    }
    throw error;
  }
});

/**
 * 等待连接终止：SSE 任务体返回即关流，这里把连接挂起到客户端断开。
 * 心跳由 createSseResponse 每 15s 发出，用于防止代理掐断空闲长连接。
 */
function waitUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * GET /api/canvas/projects/:id/events
 * 画布编辑权事件流：每个页面实例持有一条。首帧 handshake 原子下发
 * 「全量项目快照 + 编辑权租约令牌」——租约轮换与快照读取在同一写临界区内
 * 完成，编辑权与内容从结构上绑定；此后接收 evict（被抢占）。
 * 租约与抢占判定详见 services/canvas/editor-lease。
 */
router.get("/api/canvas/projects/:id/events", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = c.req.param("id");
  if (!isValidId(id)) return failCode(400, "canvas.invalid_project_id");

  const sid = c.req.query("sid")?.trim();
  if (!sid || sid.length > 64) return failCode(422, "common.invalid_request");

  // 连接前只做存在性探测（404 语义）：不重复读全量 canvasData，
  // 权威快照以临界区内那次读为准
  if (!(await projectExists(id, auth.user.id))) {
    return failCode(404, "canvas.project_not_found");
  }

  return createSseResponse(request, async ({ emit, signal }) => {
    // 握手临界区：「轮换租约 + 权威快照读」整体原子完成，与内容写互斥——
    // 下发的快照必然是该租约签发时刻的最新版本，迟到写入不可能插在其间落库
    const { joined, project } = await withProjectGate(id, async () => {
      const joined = joinCanvasRoom(id, sid, emit); // fresh → 轮换租约令牌
      const project = await getProject(id, auth.user.id);
      return { joined, project };
    });
    try {
      // 连接前已探测存在；删除竞态下快照可能已不可读：释放房间并结束流，
      // 客户端按断线重连收敛（重连探测 404 → missing 终态）
      if (!project) return;

      const payload = { revision: project.revision };
      if (joined.fresh) {
        // 快照读取成功才算完成握手：此刻才广播 evict，其余页面立即失效
        // （未完成握手的页面不产生任何驱逐）
        broadcastToOthers(id, sid, "evict", payload);
      } else if (joined.superseded) {
        // 断线期间被他人抢占：只补发 evict（不补发 handshake，页面已死），
        // 避免只靠版本号比对发现不了自己已失效
        emit("evict", payload);
        await waitUntilAbort(signal);
        return;
      }
      emit("handshake", { project, lease: joined.leaseToken });
      await waitUntilAbort(signal);
    } finally {
      leaveCanvasRoom(id, sid, joined.connId);
    }
  });
});

// DELETE /api/canvas/projects/:id
router.delete("/api/canvas/projects/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = c.req.param("id");
  if (!isValidId(id)) return failCode(400, "canvas.invalid_project_id");

  const result = await deleteProject(id, auth.user.id);
  if (result.count === 0) return failCode(404, "canvas.project_not_found");

  // 房间生命周期与项目对齐：项目删除即释放编辑权房间，
  // 在室连接的后续断开回调因房间不存在而幂等跳过
  destroyRoom(id);

  return c.json(ok(null, "Project deleted"));
});

export { router };
