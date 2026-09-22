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

// 提示词模板库（按 type 分桶，位于 server/resources/prompt-template.json），支持热更新
function loadPromptTemplates(): Record<string, string> {
  return loadJson<Record<string, string>>("prompt-template.json");
}

// GET /api/canvas/prompt-template?type=reverse
// 返回指定类型的提示词模板（模板库由后端下发，支持修改配置热更新）。
// lighting 类型额外支持 {{占位符}}：按 query 参数（intensity/azimuth/elevation/kelvin/color）
// 插值成成稿提示词，语义翻译见 services/canvas/lighting-prompt；
// angle 类型同链路（azimuth/elevation/zoom），见 services/canvas/angle-prompt；
// 其余类型为静态文案。
router.get("/api/canvas/prompt-template", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const type = c.req.query("type");
  if (!type) return failCode(400, "canvas.missing_type_param");

  const templates = loadPromptTemplates();
  const template = templates[type];
  if (template === undefined) return failCode(404, "canvas.template_not_found", { type });

  let rendered = template;
  if (type === "lighting") rendered = renderLightingTemplate(template, c.req.query());
  else if (type === "angle") rendered = renderAngleTemplate(template, c.req.query());
  return c.json(ok({ type, template: rendered }));
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
