import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { assetCreateSchema } from "@server/schemas/asset";
import { getAssets, createAsset } from "@server/crud/asset";
import { ok, fail } from "@server/core/response";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const sp = request.nextUrl.searchParams;
  const params = {
    userId: auth.user.id,
    folderId: sp.get("folder_id") ? parseInt(sp.get("folder_id")!, 10) : undefined,
    type: sp.get("type") ?? undefined,
    search: sp.get("search") ?? undefined,
    spaceKey: sp.get("space_key") ?? undefined,
    skip: sp.get("skip") ? parseInt(sp.get("skip")!, 10) : undefined,
    limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined,
  };

  const result = await getAssets(params);
  return Response.json(
    ok({ items: result.items, total: result.total })
  );
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

  const parsed = assetCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const item = await createAsset({
    userId: auth.user.id,
    name: parsed.data.name,
    type: parsed.data.type,
    width: parsed.data.width,
    height: parsed.data.height,
    description: parsed.data.description,
    tags: parsed.data.tags,
    extraData: parsed.data.extraData,
    folderId: parsed.data.folderId,
    spaceKey: parsed.data.spaceKey,
  });

  return Response.json(ok(item));
}
