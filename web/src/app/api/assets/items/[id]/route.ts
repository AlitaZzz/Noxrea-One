import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { toAssetOut } from "@server/schemas/asset";
import { getAsset, updateAsset, deleteAsset } from "@server/crud/asset";
import { ok, fail } from "@server/core/response";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid asset ID");

  const item = await getAsset(id);
  if (!item) return fail(404, "Asset not found");

  return Response.json(ok(toAssetOut(item)));
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid asset ID");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const item = await updateAsset(id, body as Record<string, unknown>);
  return Response.json(ok(toAssetOut(item)));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) return fail(400, "Invalid asset ID");

  await deleteAsset(id);
  return Response.json(ok(null, "Asset deleted"));
}
