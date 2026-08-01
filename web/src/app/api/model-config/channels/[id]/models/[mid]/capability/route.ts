import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { updateCapabilitySchema } from "@server/schemas/channel-config";
import { updateModelCapability } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { mid: rawMid } = await params;
  const modelId = parseInt(rawMid, 10);
  if (isNaN(modelId)) return fail(400, "Invalid model ID");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = updateCapabilitySchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const model = await updateModelCapability(modelId, parsed.data.capabilities);
  return Response.json(ok(model));
}
