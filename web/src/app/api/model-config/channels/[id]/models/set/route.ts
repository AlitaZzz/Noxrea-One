import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { batchSetModelsSchema } from "@server/schemas/channel-config";
import { toModelInfoOut } from "@server/schemas/channel-config";
import { batchSetModels } from "@server/crud/model-config";
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

  // 前端传 camelCase（inferredCapabilities），映射到后端期望的 snake_case
  const raw = body as { models?: Array<Record<string, unknown>> };
  if (raw.models) {
    raw.models = raw.models.map((m) => ({
      ...m,
      inferred_capabilities: m.inferredCapabilities ?? m.inferred_capabilities,
    }));
  }

  const parsed = batchSetModelsSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(422, `Schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }

  console.log("[models/set] Received", parsed.data.models.length, "models for channel", channelId);
  const models = await batchSetModels(channelId, parsed.data.models);
  console.log("[models/set] Saved", models.length, "models to DB");
  return Response.json(ok(models.map(toModelInfoOut)));
}
