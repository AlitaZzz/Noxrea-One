// ── Mock Capability Service（对应 backend/app/services/capabilities/mock/service.py） ──

import {
  registerCapability,
  type CapabilityService,
  type CapabilityContext,
  type CapabilityParams,
} from "@server/services/capabilities/base";
import { getConfig } from "@server/core/config";
import { logEvent } from "@server/core/logger/utils";
import type { GenerationResult } from "@server/schemas/result";

const MOCK_IMAGE_URLS = [
  "https://picsum.photos/1024/1024?random=1",
  "https://picsum.photos/1024/1024?random=2",
  "https://picsum.photos/1024/1024?random=3",
  "https://picsum.photos/1024/1024?random=4",
];

class MockCapabilityService implements CapabilityService {
  readonly name = "mock";

  async generate(
    ctx: CapabilityContext,
    params: CapabilityParams
  ): Promise<GenerationResult> {
    const cfg = getConfig();
    if (!cfg.MOCK_IMAGE_GENERATE) {
      throw new Error("Mock generation is disabled");
    }

    const n = (params.n as number) ?? 1;
    const urls = MOCK_IMAGE_URLS.slice(0, n);

    logEvent("capability.mock", {
      stage: "generate",
      taskId: ctx.taskId,
      n,
      urls: urls.join(","),
    });

    // 模拟延迟
    await new Promise((r) => setTimeout(r, 1000));

    return { urls };
  }
}

registerCapability("mock", new MockCapabilityService());
