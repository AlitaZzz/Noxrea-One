/**
 * 画布工程路由。
 * 处理画布工程的查询、创建、更新与删除等接口。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/http/middleware/auth";
import { canvasCreateSchema, canvasUpdateSchema } from "@server/schemas/canvas";
import {
  getProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  CanvasRevisionConflictError,
} from "@server/crud/canvas";
import { ok, failCode } from "@server/core/response";
import { isValidId } from "@server/utils/id";
import { loadJson } from "@server/services/json-loader";
import { renderAngleTemplate } from "@server/services/canvas/angle-prompt";
import { renderLightingTemplate } from "@server/services/canvas/lighting-prompt";
import { createSseResponse } from "../sse";
import { broadcastToOthers, destroyRoom, joinCanvasRoom, leaveCanvasRoom } from "../canvas-presence";

const router = new Hono();

interface BilingualText {
  zh: string;
  en: string;
}

interface PromptTemplateEntry {
  id: string;
  kind: "preset" | "reverse" | "dynamic";
  group?: string;
  label?: BilingualText;
  description?: BilingualText;
  order?: number;
  template: string;
}

interface PromptTemplateGroup {
  id: string;
  label: BilingualText;
  order: number;
}

// 文件 mtime 变化时由 json-loader 重新解析，两个接口共享同一份实时目录。
function loadPromptTemplateCatalog(): { groups: PromptTemplateGroup[]; entries: PromptTemplateEntry[] } {
  return loadJson<{ groups: PromptTemplateGroup[]; entries: PromptTemplateEntry[] }>("prompt-template.json");
}

// 两个前端入口共用可选目录：反推 + 生成预设；动态插值项不进入列表。
// label / description 为内联双语，前端按当前语言在渲染期取值，语言切换即时生效。
router.get("/api/canvas/prompt-templates", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const catalog = loadPromptTemplateCatalog();
  const selectable = catalog.entries
    .filter((entry) => entry.kind === "preset" || entry.kind === "reverse")
    .sort((a, b) => a.order! - b.order!)
    .map(({ id, kind, group, label, description, order, template }) =>
      ({ id, kind, group, label, description, order, template }));
  const groups = [...catalog.groups].sort((a, b) => a.order - b.order);
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

// GET /api/canvas/projects/:id
router.get("/api/canvas/projects/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = c.req.param("id");
  if (!isValidId(id)) return failCode(400, "canvas.invalid_project_id");

  const project = await getProject(id, auth.user.id);
  if (!project) return failCode(404, "canvas.project_not_found");

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
  // 版本校验只服务画布内容：带 canvasData 的保存必须携带 baseRevision，
  // 否则会绕过冲突检查直写；纯改名不参与版本判定，允许省略。
  if (parsed.data.canvasData !== undefined && parsed.data.baseRevision === undefined) {
    return failCode(422, "common.invalid_request");
  }

  try {
    const project = await updateProject(id, auth.user.id, {
      name: parsed.data.name,
      canvasData: parsed.data.canvasData,
    }, {
      baseRevision: parsed.data.baseRevision,
    });
    if (!project) return failCode(404, "canvas.project_not_found");
    return c.json(ok(project));
  } catch (error) {
    // 版本冲突携带当前 revision。前端同页写通道已串行化，409 即画布已在
    // 其他标签页 / 浏览器被修改（唯一例外：抢占瞬间上一任的迟到落库，前端
    // 首存撞上时按回传版本重试一次），仍冲突才弹「会话已过期」引导刷新。
    if (error instanceof CanvasRevisionConflictError) {
      return failCode(409, "canvas.project_revision_conflict", {
        revision: error.currentRevision,
      });
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
 * 画布编辑权事件流：每个页面实例持有一条，接收 evict（被抢占）与 sync（版本同步）。
 * 抢占与失效的判定详见 canvas-presence。
 */
router.get("/api/canvas/projects/:id/events", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = c.req.param("id");
  if (!isValidId(id)) return failCode(400, "canvas.invalid_project_id");

  const sid = c.req.query("sid")?.trim();
  if (!sid || sid.length > 64) return failCode(422, "common.invalid_request");

  const project = await getProject(id, auth.user.id);
  if (!project) return failCode(404, "canvas.project_not_found");

  return createSseResponse(request, async ({ emit, signal }) => {
    const { connId, fresh, superseded } = joinCanvasRoom(id, sid, emit);
    try {
      const payload = { revision: project.revision };
      if (fresh) {
        // 新页面实例取得编辑权，其余页面立即失效
        broadcastToOthers(id, sid, "evict", payload);
      } else if (superseded) {
        // 断线期间被他人抢占：只补发给本连接，避免只靠版本号比对发现不了
        emit("evict", payload);
      }
      emit("sync", payload);

      await waitUntilAbort(signal);
    } finally {
      leaveCanvasRoom(id, sid, connId);
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
