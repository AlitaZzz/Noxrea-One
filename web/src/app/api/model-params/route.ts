import { loadModelParams } from "@server/services/model-config";
import { ok } from "@server/core/response";

export async function GET() {
  const params = loadModelParams();
  return Response.json(ok(params));
}
