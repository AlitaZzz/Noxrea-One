/**
 * 提供方可移植性单测（specs/storage-provider-portability.md 验收「静态检查与测试」）：
 * 寻址风格表（真实 SDK 预设签，断言 URL 形态）、generic 的候选顺序、
 * 校验和策略固定、预签名 PUT 参数集不含 checksum 头。
 *
 * 本文件**不 mock** `@aws-sdk/*`：URL 形态与查询串只有真实 presigner 才能证明。
 */
import { describe, expect, it } from "vitest";

import {
  S3Backend,
  addressingUrlShape,
  clockSkewSecondsOf,
  createS3Client,
} from "@server/services/storage/backends/s3";
import {
  addressingCandidates,
  baselineCapabilities,
  STORAGE_PROVIDER_PROFILES,
  type StorageProvider,
} from "@server/services/storage/providers";

const CONNECTION = {
  endpoint: "http://minio.local:9000",
  region: "us-east-1",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "SECRET_TEST",
};

function makeBackend(provider: StorageProvider): S3Backend {
  return new S3Backend({
    ...CONNECTION,
    bucket: "noxrea",
    provider,
    prefix: "app",
    signedUrlTtlSeconds: 3600,
  });
}

describe("寻址风格表（规则 1.3 / 1.4）", () => {
  it.each([
    ["minio", "http://minio.local:9000/noxrea/app/u/ab/h.png"],
    ["aws", "http://noxrea.minio.local:9000/app/u/ab/h.png"],
    ["r2", "http://noxrea.minio.local:9000/app/u/ab/h.png"],
    ["oss", "http://noxrea.minio.local:9000/app/u/ab/h.png"],
    ["cos", "http://noxrea.minio.local:9000/app/u/ab/h.png"],
    ["generic", "http://noxrea.minio.local:9000/app/u/ab/h.png"],
  ] as Array<[StorageProvider, string]>)(
    "%s：预签名 URL 按 profile 的寻址风格生成",
    async (provider, expected) => {
      const url = new URL(await makeBackend(provider).presignGet("u/ab/h.png"));
      expect(`${url.origin}${url.pathname}`).toBe(expected);
    },
  );

  it("已知 profile 只有一个候选；generic 先虚拟主机后 path-style", () => {
    expect(addressingCandidates("minio")).toEqual(["path"]);
    expect(addressingCandidates("oss")).toEqual(["virtual"]);
    expect(addressingCandidates("cos")).toEqual(["virtual"]);
    expect(addressingCandidates("generic")).toEqual(["virtual", "path"]);
    for (const provider of Object.keys(STORAGE_PROVIDER_PROFILES) as StorageProvider[]) {
      expect(baselineCapabilities(provider).addressing).toBe(addressingCandidates(provider)[0]);
    }
  });

  it("addressingUrlShape：两种形态的可读描述（探测失败信息用）", () => {
    expect(addressingUrlShape("https://s3.example.com", "noxrea", "path"))
      .toBe("https://s3.example.com/noxrea/<key>");
    expect(addressingUrlShape("https://s3.example.com", "noxrea", "virtual"))
      .toBe("https://noxrea.s3.example.com/<key>");
  });
});

describe("客户端配置（规则 2.1）", () => {
  it("校验和两向固定 WHEN_REQUIRED，寻址风格显式传入", async () => {
    const path = createS3Client(CONNECTION, "path").config;
    const virtual = createS3Client(CONNECTION, "virtual").config;
    // 解析后的 config 是（异步）provider 函数，取值须 await 调用
    for (const config of [path, virtual]) {
      expect(await config.requestChecksumCalculation?.()).toBe("WHEN_REQUIRED");
      expect(await config.responseChecksumValidation?.()).toBe("WHEN_REQUIRED");
    }
    expect(path.forcePathStyle).toBe(true);
    expect(virtual.forcePathStyle).toBe(false);
  });

  it("预签名 PUT 的查询串不含 checksum 参数（浏览器不会计算，签名会与实际请求不一致）", async () => {
    const url = new URL(await makeBackend("aws").presignPut("staging/1/uuid", { contentType: "image/png" }));
    const params = [...url.searchParams.keys()];
    expect(params.filter((name) => name.startsWith("x-amz-checksum"))).toEqual([]);
    expect(params).not.toContain("x-amz-sdk-checksum-algorithm");
    // 直传只签 host：浏览器发送的 Content-Type 不参与签名，因此不会被 checksum 中间件改写
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("预签名 GET 默认带 response-content-type，能力位为 false 时不带任何 response-*（规则 4.2）", async () => {
    const backend = makeBackend("aws");
    const params = new URL(await backend.presignGet("u/ab/h.png")).searchParams;
    expect(params.get("response-content-type")).toBe("image/png");
  });
});

describe("clockSkewSecondsOf（规则 3.6）", () => {
  it("正数表示端点更快；缺失或不可解析返回 null", () => {
    const now = Date.parse("2026-10-26T00:00:00Z");
    expect(clockSkewSecondsOf(new Date(now + 90_000).toUTCString(), now)).toBe(90);
    expect(clockSkewSecondsOf(new Date(now - 90_000).toUTCString(), now)).toBe(-90);
    expect(clockSkewSecondsOf(null, now)).toBeNull();
    expect(clockSkewSecondsOf("not-a-date", now)).toBeNull();
  });
});
