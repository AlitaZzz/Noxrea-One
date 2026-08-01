import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { canvasUpdateSchema } from "@server/schemas/canvas";
import { getProject, updateProject, deleteProject, recalcFileReferences } from "@server/crud/canvas";
import { ok, fail } from "@server/core/response";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid project ID");

  const project = await getProject(id);
  if (!project) return fail(404, "Project not found");
  if (project.userId !== auth.user.id) return fail(403, "Access denied");

  return Response.json(ok(project));
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid project ID");

  const existing = await getProject(id);
  if (!existing) return fail(404, "Project not found");
  if (existing.userId !== auth.user.id) return fail(403, "Access denied");

  let body: unknown;
  try {
    body = await request.json();
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

  // 文件引用重算（如果有 canvasData 则提取文件引用）
  if (parsed.data.canvasData) {
    // 从 canvasData 提取文件 hash 引用（由前端在 canvasData 中标记）
    // 当前简化实现：不做自动提取，后续可根据需要接入
  }

  return Response.json(ok(project));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid project ID");

  const existing = await getProject(id);
  if (!existing) return fail(404, "Project not found");
  if (existing.userId !== auth.user.id) return fail(403, "Access denied");

  await deleteProject(id);
  return Response.json(ok(null, "Project deleted"));
}
