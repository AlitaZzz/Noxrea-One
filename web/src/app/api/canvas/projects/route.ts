import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { canvasCreateSchema } from "@server/schemas/canvas";
import { getProjects, createProject } from "@server/crud/canvas";
import { ok, fail } from "@server/core/response";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const projects = await getProjects(auth.user.id);
  return Response.json(ok(projects));
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
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

  return Response.json(ok(project));
}
