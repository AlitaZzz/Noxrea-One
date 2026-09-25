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

const router = new Hono();

interface PromptTemplateEntry {
  id: string;
  kind: "preset" | "reverse" | "dynamic";
  labelKey?: string;
  order?: number;
  template: string;
}

// 文件 mtime 变化时由 json-loader 重新解析，两个接口共享同一份实时目录。
function loadPromptTemplates(): PromptTemplateEntry[] {
  return loadJson<{ entries: PromptTemplateEntry[] }>("prompt-template.json").entries;
}

// 两个前端入口共用可选目录：反推 + 生成预设；动态插值项不进入列表。
router.get("/api/canvas/prompt-templates", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const selectable = loadPromptTemplates()
    .filter((entry) => entry.kind === "preset" || entry.kind === "reverse")
    .sort((a, b) => a.order! - b.order!)
    .map(({ id, kind, labelKey, order, template }) => ({ id, kind, labelKey, order, template }));
  return c.json(ok(selectable));
});

router.get("/api/canvas/prompt-template", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const type = c.req.query("type");
  if (!type) return failCode(400, "canvas.missing_type_param");

  const entry = loadPromptTemplates().find((item) => item.id === type);
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
      // 只有媒体结构指纹变化时前端才标记 needRefRecalc；布局保存不进入账本计算。
      recalcRefs: Boolean(parsed.data.needRefRecalc && parsed.data.canvasData),
      baseRevision: parsed.data.baseRevision,
    });
    if (!project) return failCode(404, "canvas.project_not_found");
    return c.json(ok(project));
  } catch (error) {
    // 版本冲突携带当前 revision。前端同页写通道已串行化，409 即画布已在
    // 其他标签页 / 浏览器被修改，据此弹「会话已过期」引导刷新。
    if (error instanceof CanvasRevisionConflictError) {
      return failCode(409, "canvas.project_revision_conflict", {
        revision: error.currentRevision,
      });
    }
    throw error;
  }

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

  return c.json(ok(null, "Project deleted"));
});

export { router };
