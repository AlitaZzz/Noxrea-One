/**
 * XML 判定流式状态机直接单测：覆盖流式特有的风险分支——
 * BOM/端序判定、UTF-16 跨块半码元 carry、BOM 跨块喂入、<3 字节短流、
 * 长空白后置标签跨多块——并与整份 Buffer 退化用法做同输入同判定对齐。
 */
import { describe, expect, it } from "vitest";
import { createXmlContentDetector, isXmlContent } from "@server/services/storage/xml-content";

/** 逐块喂入后定型的便捷封装 */
function feed(chunks: Buffer[]): boolean {
  const detector = createXmlContentDetector();
  for (const chunk of chunks) detector.feed(chunk);
  return detector.isXml();
}

describe("createXmlContentDetector（流式 XML 判定状态机）", () => {
  it("ASCII 首个非空白码元为 '<'：true；二进制字节：false（判定栓定后不受后续字节影响）", () => {
    expect(feed([Buffer.from("<svg/>")])).toBe(true);
    expect(feed([Buffer.from("  \t\r\n <svg/>")])).toBe(true);
    expect(feed([Buffer.from([0x01, 0x3c])])).toBe(false);
    expect(feed([Buffer.from([0x89, 0x50, 0x4e, 0x47])])).toBe(false);
  });

  it("UTF-8 BOM + 标签：true；纯空白（BOM 后无内容）：false", () => {
    expect(isXmlContent(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<svg/>")]))).toBe(true);
    expect(isXmlContent(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("   ")]))).toBe(false);
  });

  it("UTF-16 BOM 双端序 + 标签：true", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<svg/>", "utf16le")]);
    expect(isXmlContent(le)).toBe(true);
    // BE 无原生编码名：手工构造 "<svg/>" 的大端 UTF-16 字节
    const beBody = Buffer.from("<svg/>", "utf16le").swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
    expect(isXmlContent(be)).toBe(true);
  });

  it("无 BOM 的 UTF-16 起始字节形态：true", () => {
    expect(isXmlContent(Buffer.from("<svg/>", "utf16le"))).toBe(true);
    expect(isXmlContent(Buffer.from("<svg/>", "utf16le").swap16())).toBe(true);
  });

  it("BOM 跨块喂入（head 分两块填满）：true", () => {
    expect(feed([Buffer.from([0xff, 0xfe]), Buffer.from("<svg/>", "utf16le")])).toBe(true);
    expect(feed([Buffer.from([0xfe, 0xff]), Buffer.from("<svg/>", "utf16le").swap16()])).toBe(true);
    expect(feed([Buffer.from([0xef]), Buffer.from([0xbb, 0xbf]), Buffer.from("<svg/>")])).toBe(true);
  });

  it("UTF-16 半码元跨块 carry：奇数字节边界的待配对字节保留到下一块", () => {
    // head 恰好 3 字节（BOM + 首个内容字节），配对字节的另一半在下一块
    expect(feed([Buffer.from([0xff, 0xfe, 0x3c]), Buffer.from([0x00])])).toBe(true);
    // 空白码元跨块后置标签
    expect(feed([Buffer.from([0xff, 0xfe]), Buffer.from([0x20, 0x00]), Buffer.from([0x3c, 0x00])])).toBe(true);
  });

  it("短流（<3 字节）与空流：与整份 Buffer 判定同语义", () => {
    expect(feed([Buffer.from([0x3c])])).toBe(true);
    expect(feed([Buffer.from([0x3c, 0x00])])).toBe(true);
    expect(feed([Buffer.from([0xff, 0xfe])])).toBe(false);
    expect(feed([])).toBe(false);
    expect(isXmlContent(Buffer.alloc(0))).toBe(false);
  });

  it("长空白后置标签跨多块（原固定前缀截断的漏判形态）：true", () => {
    const padded = Buffer.concat([Buffer.from(" ".repeat(9000)), Buffer.from("<svg/>")]);
    const chunks: Buffer[] = [];
    for (let i = 0; i < padded.length; i += 512) chunks.push(padded.subarray(i, i + 512));
    expect(feed(chunks)).toBe(true);
  });

  it("整份 Buffer 退化用法与流式逐块喂入同输入同判定", () => {
    const inputs: Buffer[] = [
      Buffer.from("<svg/>"),
      Buffer.from("hello"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<svg/>", "utf16le")]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("  <?xml?>")]),
      Buffer.from([0x00, 0x3c, 0x00, 0x73]),
      Buffer.alloc(0),
      Buffer.from("   \n\t "),
    ];
    for (const input of inputs) {
      expect(feed([input])).toBe(isXmlContent(input));
    }
  });
});
