import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { modelInfoCreateSchema } from "@server/schemas/channel-config";
import { addModel } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: rawId } = await params;
  const channelId = parseInt(rawId, 10);
  if (isNaN(channelId)) return fail(400, "Invalid channel ID");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = modelInfoCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const model = await addModel(channelId, {
    name: parsed.data.name,
    capabilities: parsed.data.capabilities,
  });

  return Response.json(ok(model));
}
