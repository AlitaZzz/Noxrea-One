/** XML 内容判定规则层（中转与直传共用）：独立于上传流程，不拖入其持久化/媒体依赖图。 */

/**
 * XML 内容判定状态机（中转与直传共用单一实现）：逐块喂入字节流，
 * 在首个非空白码元处定型，不缓冲整份文件。判定规则：
 * 按 BOM / 起始字节选 UTF-8 / UTF-16 端序与跳步宽度，跳过 BOM 与空白码元后，
 * 首个非空白码元为 '<' 才算 XML 文本。流式喂入消除了固定前缀截断的漏判面
 * （长空白 / 长注释后置 '<svg' 的构造文件在中转与直传两侧行为一致）。
 */
export interface XmlContentDetector {
  feed(chunk: Buffer): void;
  isXml(): boolean;
}

export function createXmlContentDetector(): XmlContentDetector {
  // 端序判定最多读前 3 字节（UTF-8 BOM 三字节；UTF-16 BOM 与无 BOM 形态两字节即可）
  const head = Buffer.alloc(3);
  let headLen = 0;
  let step = 0; // 0 = 端序/步宽未定（字节数不足）；1 = UTF-8；2 = UTF-16
  let littleEndian = true;
  let headScan = 0;
  let carry = -1; // UTF-16 跨块半码元（待配对字节）
  let verdict: boolean | null = null;

  const check = (code: number): void => {
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) return;
    verdict = code === 0x3c;
  };
  const detectHeader = (): void => {
    // 短流（<3 字节）下越界位按 undefined 参与比较，与整份 Buffer 判定同语义
    const b = (i: number): number | undefined => (i < headLen ? head[i] : undefined);
    if (b(0) === 0xff && b(1) === 0xfe) {
      headScan = 2;
      step = 2;
    } else if (b(0) === 0xfe && b(1) === 0xff) {
      headScan = 2;
      step = 2;
      littleEndian = false;
    } else if (b(0) === 0xef && b(1) === 0xbb && b(2) === 0xbf) {
      headScan = 3;
      step = 1;
    } else if (b(0) === 0 && b(1) === 0x3c) {
      step = 2;
      littleEndian = false;
    } else if (b(0) === 0x3c && b(1) === 0) {
      step = 2;
    } else {
      step = 1;
    }
  };
  /** 逐字节扫描（UTF-8 步宽）：遇非空白码元即定型 */
  const scanBytes = (read: (index: number) => number, from: number, to: number): void => {
    for (let k = from; k < to && verdict === null; k++) check(read(k));
  };
  /** UTF-16 配对扫描（半码元 carry 进出）：遇非空白码元即定型，返回未配对的尾字节 */
  const scanUtf16 = (read: (index: number) => number, from: number, to: number, carry: number): number => {
    let hi = carry;
    for (let k = from; k < to && verdict === null; k++) {
      const byte = read(k);
      if (hi < 0) {
        hi = byte;
        continue;
      }
      check(littleEndian ? (byte << 8) | hi : (hi << 8) | byte);
      hi = -1;
    }
    return hi;
  };
  /** 扫描 head 中尚未消费的余量（BOM 跳过 + 步宽配对）；仅在端序定型时调用一次 */
  const scanHead = (): void => {
    if (step === 1) {
      scanBytes((k) => head[k], headScan, headLen);
      return;
    }
    // head 尾部奇数字节经返回值进入本块余量的配对流（如 BOM 后首个内容字节）
    carry = scanUtf16((k) => head[k], headScan, headLen, -1);
  };

  return {
    feed(chunk: Buffer): void {
      if (verdict !== null) return;
      let i = 0;
      if (step === 0) {
        const take = Math.min(3 - headLen, chunk.length);
        chunk.copy(head, headLen, 0, take);
        headLen += take;
        i = take;
        if (headLen < 3) return; // 端序判定字节不足，等待后续块（流耗尽时由 isXml 定型）
        detectHeader();
        scanHead();
        headScan = headLen; // head 一次性消费，后续块不再回扫
      }
      if (step === 1) {
        scanBytes((k) => chunk[k], i, chunk.length);
        return;
      }
      // UTF-16：与上一块的半码元配对后逐对判定
      carry = scanUtf16((k) => chunk[k], i, chunk.length, carry);
    },
    isXml(): boolean {
      if (verdict === null) {
        if (step === 0) {
          detectHeader();
          scanHead();
        }
        verdict ??= false;
      }
      return verdict;
    },
  };
}

/**
 * 整份 Buffer 的 XML 判定：共用流式状态机的退化用法（一次性喂入）。
 * 中转上传按此调用；直传复验流逐块 feed 同一状态机。
 */
export function isXmlContent(buffer: Buffer): boolean {
  const detector = createXmlContentDetector();
  detector.feed(buffer);
  return detector.isXml();
}
