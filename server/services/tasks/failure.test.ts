/**
 * 上游失败翻译规则测试：上游文案优先原样回传（不附错误码），
 * 取不到时回退兜底文案 + 错误码。
 */
import { describe, expect, it } from "vitest";

import { failFromUpstream } from "./failure";

describe("failFromUpstream", () => {
  it("上游有可读文案时原样回传且不带错误码", () => {
    expect(failFromUpstream("content policy violation", { message: "HTTP 400", code: "generation.upstream_http_error" }))
      .toEqual({ error: "content policy violation" });
  });

  it("上游无文案时回退兜底文案与错误码", () => {
    expect(failFromUpstream("", { message: "HTTP 502", code: "generation.upstream_http_error" }))
      .toEqual({ error: "HTTP 502", errorCode: "generation.upstream_http_error" });
  });
});
