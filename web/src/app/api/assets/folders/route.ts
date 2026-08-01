import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { folderCreateSchema } from "@server/schemas/asset";
import { getFolders, createFolder } from "@server/crud/asset";
import { ok, fail } from "@server/core/response";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const searchParams = request.nextUrl.searchParams;
  const spaceKey = searchParams.get("space_key") ?? "personal";

  const folders = await getFolders(auth.user.id, spaceKey);
  return Response.json(ok(folders));
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

  const parsed = folderCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const folder = await createFolder(auth.user.id, {
    name: parsed.data.name,
    spaceKey: parsed.data.spaceKey,
    parentId: parsed.data.parentId,
  });

  return Response.json(ok(folder));
}
