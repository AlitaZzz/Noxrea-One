import { Hono } from "hono";
import { loadModelParams } from "@server/services/model-config";
import { ok } from "@server/core/response";

const router = new Hono();

// ── GET /api/model-params ──
router.get("/api/model-params", (c) => {
  const params = loadModelParams();
  return c.json(ok(params));
});

export { router };
