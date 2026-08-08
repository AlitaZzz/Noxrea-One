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

const router = new Hono();

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

  const project = await getProject(id);
  if (!project) return fail(404, "Project not found");
  if (project.userId !== auth.user.id) return fail(403, "Access denied");

  return c.json(ok(project));
});

// PUT /api/canvas/projects/:id
router.put("/api/canvas/projects/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return fail(400, "Invalid project ID");

  const existing = await getProject(id);
  if (!existing) return fail(404, "Project not found");
  if (existing.userId !== auth.user.id) return fail(403, "Access denied");

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

  const project = await updateProject(id, {
    name: parsed.data.name,
    canvasData: parsed.data.canvasData,
  });

  // 文件引用重算（diff 增减）
  if (parsed.data.needRefRecalc && parsed.data.canvasData) {
    const newHashes = extractHashesFromCanvas(parsed.data.canvasData);
    const oldHashes = extractHashesFromCanvas(existing.canvasData as Record<string, unknown>);
    void recalcCanvasRefs(auth.user.id, oldHashes, newHashes);
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

  const existing = await getProject(id);
  if (!existing) return fail(404, "Project not found");
  if (existing.userId !== auth.user.id) return fail(403, "Access denied");

  await deleteProject(id);

  // 异步递减文件引用计数 + GC 孤儿文件
  const oldHashes = extractHashesFromCanvas(existing.canvasData as Record<string, unknown>);
  void cleanCanvasRefs(auth.user.id, oldHashes);

  return c.json(ok(null, "Project deleted"));
});

export { router };
