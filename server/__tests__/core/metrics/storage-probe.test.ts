/**
 * storageProbe 的指标边界回归：metrics 接收自有扁平入参，
 * 标签集合与本模块声明一致；不依赖 services 的 StorageCapabilities。
 */
import { describe, expect, it } from "vitest";

import { metrics } from "@server/core/metrics";

describe("storageProbe 指标入参", () => {
  it("扁平入参直接映射为标签与时钟偏差", async () => {
    metrics.storageProbe({
      addressing: "path",
      responseOverrides: false,
      browserCors: true,
      clockSkewSeconds: 1.25,
    });

    const ok = await metrics.registry.getSingleMetric("storage_probe_ok")!.get();
    expect(ok.values).toContainEqual(
      expect.objectContaining({
        labels: {
          addressing: "path",
          response_overrides: "false",
          browser_cors: "true",
        },
        value: 1,
      }),
    );

    const skew = await metrics.registry.getSingleMetric("storage_probe_clock_skew_seconds")!.get();
    expect(skew.values).toContainEqual(expect.objectContaining({ value: 1.25 }));
  });
});
