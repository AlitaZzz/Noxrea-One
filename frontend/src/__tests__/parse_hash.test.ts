/**
 * _parse_hash_from_url / _extractHashFromUrl — 前端版本安全网测试。
 *
 * 覆盖 save-manager.ts 中 _extractHashFromUrl 的当前行为。
 *
 * URL 格式: /api/files/{user_id}/{hash[:2]}/{hash}{ext}
 * 返回 64 字符 SHA256 hex hash 或 null。
 */

import { describe, it, expect } from "vitest";

// ════════════════════════════════════════════════════════════════════
// 测试辅助：提取 save-manager.ts _extractHashFromUrl 的逻辑
// ════════════════════════════════════════════════════════════════════

/**
 * 匹配 save-manager.ts L24-35 的实现。
 * 提取 /api/files/{user_id}/{hash[:2]}/{hash}{ext} 中的 64 位 hash。
 */
function extractHashFromUrl(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  const idx = url.indexOf("/api/files/");
  if (idx === -1) return null;
  const path = url.slice(idx + "/api/files/".length);
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const fn = parts[2];
  const dot = fn.lastIndexOf(".");
  const h = dot > 0 ? fn.slice(0, dot) : fn;
  return h.length === 64 ? h : null;
}

/**
 * 匹配 save-manager.ts L37-57 的实现。
 * 从节点数组中收集所有文件的 hash。
 */
function collectCanvasHashes(nodes: any[]): string[] {
  const hashes: string[] = [];
  for (const node of nodes) {
    const d = node?.data || {};
    if (typeof d.src === "string") {
      const h = extractHashFromUrl(d.src);
      if (h) hashes.push(h);
    }
    if (Array.isArray(d.images)) {
      for (const img of d.images) {
        if (img?.url) {
          const h = extractHashFromUrl(img.url);
          if (h) hashes.push(h);
        }
      }
    }
  }
  return [...new Set(hashes)].sort();
}

// ════════════════════════════════════════════════════════════════════
// 测试
// ════════════════════════════════════════════════════════════════════

describe("_extractHashFromUrl（前端 save-manager 版本）", () => {
  const hash64 = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

  it("从标准 CAS URL 提取 64 字符 hash", () => {
    const url = `http://test/api/files/1/${hash64.slice(0, 2)}/${hash64}.png`;
    expect(extractHashFromUrl(url)).toBe(hash64);
  });

  it("无扩展名的 URL", () => {
    const url = `http://test/api/files/1/${hash64.slice(0, 2)}/${hash64}`;
    expect(extractHashFromUrl(url)).toBe(hash64);
  });

  it("不同 host 也可正确提取", () => {
    const url = `https://cdn.example.com/api/files/5/${hash64.slice(0, 2)}/${hash64}.jpg`;
    expect(extractHashFromUrl(url)).toBe(hash64);
  });

  it("不带 /api/files/ 时返回 null", () => {
    expect(extractHashFromUrl("http://example.com/file.png")).toBeNull();
  });

  it("hash 不是 64 字符时返回 null", () => {
    expect(extractHashFromUrl(`http://test/api/files/1/ab/short.png`)).toBeNull();
  });

  it("URL 路径部分数不等于 3 时返回 null", () => {
    expect(extractHashFromUrl(`http://test/api/files/1/ab/${hash64}.png/extra`)).toBeNull();
  });

  it("非字符串输入返回 null", () => {
    expect(extractHashFromUrl(null as any)).toBeNull();
    expect(extractHashFromUrl(undefined as any)).toBeNull();
    expect(extractHashFromUrl("")).toBeNull();
  });

  it("URL 中有多个 / 但精确片段匹配", () => {
    // 确保路径分割正确：parts 应为 ["1", "ab", "hash.ext"]
    const url = `http://test/api/files/1/ab/${hash64}.png`;
    expect(extractHashFromUrl(url)).toBe(hash64);
  });

  it("hash 为 64 个 0（全零边缘情况）", () => {
    const zeroHash = "0".repeat(64);
    const url = `http://test/api/files/1/00/${zeroHash}.png`;
    expect(extractHashFromUrl(url)).toBe(zeroHash);
  });

  it("hash 为 64 个 f（全 f 边缘情况）", () => {
    const fHash = "f".repeat(64);
    const url = `http://test/api/files/999/ff/${fHash}.bin`;
    expect(extractHashFromUrl(url)).toBe(fHash);
  });
});

describe("_collectCanvasHashes（前端 save-manager 版本）", () => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);

  it("从 video-node 和 image-node 的 data.src 收集", () => {
    const nodes = [
      { data: { src: `/api/files/1/${hashA.slice(0, 2)}/${hashA}.png` } },
      { data: { src: `/api/files/2/${hashB.slice(0, 2)}/${hashB}.jpg` } },
    ];
    expect(collectCanvasHashes(nodes)).toEqual([hashA, hashB]);
  });

  it("从 image-group-node 的 data.images[].url 收集", () => {
    const nodes = [
      { data: { images: [{ url: `/api/files/1/${hashA.slice(0, 2)}/${hashA}.jpg` }] } },
    ];
    expect(collectCanvasHashes(nodes)).toEqual([hashA]);
  });

  it("重复 hash 去重并排序", () => {
    const nodes = [
      { data: { src: `/api/files/1/${hashA.slice(0, 2)}/${hashA}.png` } },
      { data: { src: `/api/files/1/${hashA.slice(0, 2)}/${hashA}.png` } },
      { data: { src: `/api/files/2/${hashB.slice(0, 2)}/${hashB}.jpg` } },
    ];
    expect(collectCanvasHashes(nodes)).toEqual([hashA, hashB]);
  });

  it("混合 src + images 一起收集", () => {
    const hashC = "c".repeat(64);
    const nodes = [
      { data: { src: `/api/files/1/${hashA.slice(0, 2)}/${hashA}.png` } },
      { data: { images: [{ url: `/api/files/3/${hashC.slice(0, 2)}/${hashC}.webp` }] } },
    ];
    expect(collectCanvasHashes(nodes)).toEqual([hashA, hashC]);
  });

  it("非 hash URL（非 /api/files/ 模式）被忽略", () => {
    const nodes = [
      { data: { src: "http://cdn.example.com/external.png" } },
      { data: { src: "data:image/png;base64,abc123" } },
    ];
    expect(collectCanvasHashes(nodes)).toEqual([]);
  });

  it("缺失 data 或空 nodes 返回空数组", () => {
    expect(collectCanvasHashes([])).toEqual([]);
    expect(collectCanvasHashes([{}])).toEqual([]);
    expect(collectCanvasHashes([{ data: null }])).toEqual([]);
  });
});
