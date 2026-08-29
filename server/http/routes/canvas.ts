/**
 * 画布工程路由。
 * 处理画布工程的查询、创建、更新与删除等接口。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { canvasCreateSchema, canvasUpdateSchema } from "@server/schemas/canvas";
import { getProjects, createProject, getProject, updateProject, deleteProject } from "@server/crud/canvas";
import { ok, fail } from "@server/core/response";
import { recalcCanvasRefs, cleanCanvasRefs } from "@server/services/storage/ref-manager";
import { extractHashesFromCanvas } from "@server/utils/extract-hashes";
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
  if (!type) return fail(400, "Missing 'type' query parameter");

  const templates = loadPromptTemplates();
  const template = templates[type];
  if (template === undefined) return fail(404, `Prompt template '${type}' not found`);

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
    return fail(400, "Invalid JSON body");
  }

  const parsed = canvasCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
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

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid project ID");

  const project = await getProject(id, auth.user.id);
  if (!project) return fail(404, "Project not found");

  return c.json(ok(project));
});

// PUT /api/canvas/projects/:id
router.put("/api/canvas/projects/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid project ID");

  const existing = await getProject(id, auth.user.id);
  if (!existing) return fail(404, "Project not found");


  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = canvasUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const project = await updateProject(id, auth.user.id, {
    name: parsed.data.name,
    canvasData: parsed.data.canvasData,
  });
  if (!project) return fail(404, "Project not found");

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

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid project ID");

  const existing = await getProject(id, auth.user.id);
  if (!existing) return fail(404, "Project not found");


  const result = await deleteProject(id, auth.user.id);
  if (result.count === 0) return fail(404, "Project not found");

  const oldHashes = extractHashesFromCanvas(existing.canvasData as Record<string, unknown>);
  await cleanCanvasRefs(auth.user.id, oldHashes);

  return c.json(ok(null, "Project deleted"));
});

export { router };
