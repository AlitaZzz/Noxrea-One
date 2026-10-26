/**
 * S3 后端真桶集成测试（specs/storage-provider-portability.md 规则 6.1）。
 *
 * 环境变量（全部就绪才执行，否则整组跳过；口径同 Redis 集成测试）：
 * - `TEST_S3_ENDPOINT` / `TEST_S3_BUCKET` / `TEST_S3_REGION`
 * - `TEST_S3_ACCESS_KEY_ID` / `TEST_S3_SECRET_ACCESS_KEY`
 * - `TEST_S3_PROVIDER`（可选，缺省 `generic`：由探测决定寻址）
 * - `TEST_S3_PREFIX`（可选，缺省 `it-probe`：本测试所有对象都在该前缀下，结束即删）
 *
 * MinIO 契约测试（规则 6.1 的容器矩阵）：
 *   docker compose -f docker-compose.test.yml up -d minio
 *   npm run test:storage:minio
 * 该脚本注入上表变量的 MinIO 取值（回环端点、固定测试凭据、`minio` profile），
 * 桶由 compose 的 `minio-init` 建好。
 *
 * 隔离约束：只读写本次生成的唯一 key（`{prefix}/_probe/<uuid>`），不列举、不清空桶；
 * 禁止把本测试指向生产桶——探测会写入至少 1KB 对象并删除。
 */
import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";

import { S3Backend } from "@server/services/storage/backends/s3";
import type { StorageProvider } from "@server/services/storage/providers";

const env = {
  endpoint: process.env.TEST_S3_ENDPOINT,
  bucket: process.env.TEST_S3_BUCKET,
  region: process.env.TEST_S3_REGION,
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY,
};
const configured = Object.values(env).every((value) => Boolean(value));

describe.skipIf(!configured)("S3Backend（真桶）", () => {
  const provider = (process.env.TEST_S3_PROVIDER ?? "generic") as StorageProvider;
  const prefix = process.env.TEST_S3_PREFIX ?? "it-probe";
  const backend = new S3Backend({
    endpoint: env.endpoint!,
    bucket: env.bucket!,
    region: env.region!,
    accessKeyId: env.accessKeyId!,
    secretAccessKey: env.secretAccessKey!,
    provider,
    prefix,
    signedUrlTtlSeconds: 3600,
  });
  const created: string[] = [];

  afterAll(async () => {
    // 尽力清理本测试写过的 key（删除失败只留诊断信息，不影响其他用例结论）
    for (const key of created) await backend.delete(key).catch(() => {});
  });

  it("六项能力探测通过，并给出能力位", async () => {
    const report = await backend.probe();
    // 探测报告的能力位落回后端：读路径据此决定覆盖头与下载形态。
    // 预签名回读不在这里——它是致命项（spec 3.5.1），走通即证明签名链路可用。
    expect(backend.capabilities()).toEqual(report.capabilities);
    // CORS 与时钟只告警（部署侧配置），不参与断言
    expect(report.warnings.every((warning) => typeof warning === "string")).toBe(true);
  });

  it("写 / 回读 / stat / 列举 / 删除全链路一致", async () => {
    const key = `${prefix}-rt/${randomUUID()}.bin`;
    created.push(key);
    const payload = Buffer.alloc(2048, 0x41);

    await backend.put(key, payload);
    const chunks: Buffer[] = [];
    for await (const chunk of await backend.get(key)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
    await expect(backend.stat(key)).resolves.toMatchObject({ size: payload.length });

    const listed = await backend.list(`${prefix}-rt/`);
    expect(listed.some((entry) => entry.key === key)).toBe(true);

    await backend.delete(key);
    await expect(backend.stat(key)).resolves.toBeNull();
    created.pop();
  });

  it("预签名 GET 可被无凭据客户端取回（浏览器直连的等价形态）", async () => {
    const key = `${prefix}-sign/${randomUUID()}.txt`;
    created.push(key);
    const payload = Buffer.from("presigned-readback");
    await backend.put(key, payload);

    const url = await backend.presignGet(key, { ttlSeconds: 300, windowSeconds: 60 });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(payload)).toBe(true);

    await backend.delete(key);
    created.pop();
  });
});
