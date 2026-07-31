import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { assetBatchCreateSchema, assetBatchUpdateSchema } from "@server/schemas/asset";
import { toAssetOut } from "@server/schemas/asset";
import { createAssetsBatch, updateAssetsBatch } from "@server/crud/asset";
import { ok, fail } from "@server/core/response";

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = assetBatchCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const items = parsed.data.map((item) => ({
    userId: auth.user.id,
    name: item.name,
    type: item.type,
    width: item.width,
    height: item.height,
    description: item.description,
    tags: item.tags,
    extraData: item.extra_data,
    folderId: item.folder_id,
    spaceKey: item.space_key,
  }));

  const created = await createAssetsBatch(items);
  return Response.json(ok(created.map(toAssetOut)));
}

export async function PUT(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = assetBatchUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const result = await updateAssetsBatch(parsed.data.ids, parsed.data.updates);
  return Response.json(ok(result));
}
