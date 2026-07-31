import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { deleteModel } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { mid: rawMid } = await params;
  const modelId = parseInt(rawMid, 10);
  if (isNaN(modelId)) return fail(400, "Invalid model ID");

  await deleteModel(modelId);
  return Response.json(ok(null, "Model deleted"));
}
