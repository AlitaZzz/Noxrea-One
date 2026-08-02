import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { canvasCreateSchema, canvasUpdateSchema } from "@server/schemas/canvas";
import { getProjects, createProject, getProject, updateProject, deleteProject } from "@server/crud/canvas";
import { ok, fail } from "@server/core/response";

const router = new Hono();

// ── GET /api/canvas/projects ──
router.get("/api/canvas/projects", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const projects = await getProjects(auth.user.id);
  return c.json(ok(projects));
});

// ── POST /api/canvas/projects ──
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

// ── GET /api/canvas/projects/:id ──
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

// ── PUT /api/canvas/projects/:id ──
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

  return c.json(ok(project));
});

// ── DELETE /api/canvas/projects/:id ──
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
  return c.json(ok(null, "Project deleted"));
});

export { router };
