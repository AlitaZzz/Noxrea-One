import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { listSourceUrls } from "@server/crud/asset";
import { ok } from "@server/core/response";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const searchParams = request.nextUrl.searchParams;
  const spaceKey = searchParams.get("space_key") ?? "personal";

  const urls = await listSourceUrls(auth.user.id, spaceKey);
  return Response.json(ok(urls));
}
