/**
 * 画布工程路由。
 * 处理画布工程的查询、创建、更新与删除等接口。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { canvasCreateSchema, canvasUpdateSchema } from "@server/schemas/canvas";
import { getProjects, createProject, getProject, updateProject, deleteProject } from "@server/crud/canvas";
import { ok, failCode } from "@server/core/response";
import { recalcCanvasRefs, cleanCanvasRefs } from "@server/services/storage/ref-manager";
import { extractHashesFromCanvas } from "@server/utils/extract-hashes";
import { isValidId } from "@server/utils/id";
import { loadJson } from "@server/services/json-loader";

const router = new Hono();

// 提示词模板库（按 type 分桶，位于 server/resources/prompt-template.json），支持热更新
function loadPromptTemplates(): Record<string, string> {
  return loadJson<Record<string, string>>("prompt-template.json");
}

// GET /api/canvas/prompt-template?type=reverse
// 返回指定类型的提示词模板（模板库由后端下发，支持修改配置热更新）。
router.get("/api/canvas/prompt-template", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const type = c.req.query("type");
  if (!type) return failCode(400, "canvas.missing_type_param");

  const templates = loadPromptTemplates();
  const template = templates[type];
  if (template === undefined) return failCode(404, "canvas.template_not_found", { type });

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

  const existing = await getProject(id, auth.user.id);
  if (!existing) return failCode(404, "canvas.project_not_found");


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

  const project = await updateProject(id, auth.user.id, {
    name: parsed.data.name,
    canvasData: parsed.data.canvasData,
  });
  if (!project) return failCode(404, "canvas.project_not_found");

  // 文件引用重算（diff 增减）
  if (parsed.data.needRefRecalc && parsed.data.canvasData) {
    const newHashes = extractHashesFromCanvas(parsed.data.canvasData);
    const oldHashes = extractHashesFromCanvas(existing.canvasData as Record<string, unknown>);
    await recalcCanvasRefs(auth.user.id, oldHashes, newHashes);
  }

  return c.json(ok(project));
});

// DELETE /api/canvas/projects/:id
router.delete("/api/canvas/projects/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = c.req.param("id");
  if (!isValidId(id)) return failCode(400, "canvas.invalid_project_id");

  const existing = await getProject(id, auth.user.id);
  if (!existing) return failCode(404, "canvas.project_not_found");


  const result = await deleteProject(id, auth.user.id);
  if (result.count === 0) return failCode(404, "canvas.project_not_found");

  const oldHashes = extractHashesFromCanvas(existing.canvasData as Record<string, unknown>);
  await cleanCanvasRefs(auth.user.id, oldHashes);

  return c.json(ok(null, "Project deleted"));
});

export { router };
