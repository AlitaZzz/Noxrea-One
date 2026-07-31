import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { folderUpdateSchema, toFolderOut } from "@server/schemas/asset";
import { getFolder, updateFolder, deleteFolder } from "@server/crud/asset";
import { ok, fail } from "@server/core/response";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid folder ID");

  const folder = await getFolder(id);
  if (!folder) return fail(404, "Folder not found");

  return Response.json(ok(toFolderOut(folder)));
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid folder ID");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = folderUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const folder = await updateFolder(id, parsed.data.name);
  return Response.json(ok(toFolderOut(folder)));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid folder ID");

  await deleteFolder(id);
  return Response.json(ok(null, "Folder deleted"));
}
