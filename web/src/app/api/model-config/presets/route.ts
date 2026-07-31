import { loadPresets } from "@server/services/model-config";
import { ok } from "@server/core/response";

export async function GET() {
  const presets = loadPresets();
  return Response.json(ok(presets));
}
