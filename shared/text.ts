/**
 * 文本长度截断的共享规则（服务端附件名与前端下载名共用）。
 *
 * 长度预算来自文件系统 / 协议上限（`String.prototype.length` 的 UTF-16 码元数），
 * 但补充平面字符（emoji 等）占 2 个码元：按码元硬切会把代理对劈成孤立代理，
 * 之后编码为 UTF-8（URL、HTTP 头）直接抛 URIError。截断点落在代理对中间时少留 1 码元。
 */

/** 按 UTF-16 码元数截断，绝不产出孤立代理（代理对整体保留或整体丢弃） */
export function truncateUtf16(value: string, maxUnits: number): string {
  const limit = Math.max(0, Math.floor(maxUnits));
  if (value.length <= limit) return value;
  // 切点前一个码元是高位代理：其低位代理在切点之后，必须一并丢弃
  const lastKept = value.charCodeAt(limit - 1);
  const splitsPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return value.slice(0, splitsPair ? limit - 1 : limit);
}

/**
 * 归一为 well-formed UTF-16（孤立代理 → U+FFFD）。
 * 不可信文本进入编码边界（`encodeURIComponent` / HTTP 头）前必须经过本函数。
 *
 * 不调用 `String.prototype.toWellFormed`：本模块被浏览器端（下载文件名）与 Node 端共用，
 * 而 natives 的可用版本取决于运行时。浏览器的编译目标由 Next 的现代基线决定
 * （chrome/edge/firefox 111、safari 16.4），该基线内 Firefox 111–118 尚无此方法；
 * 在一个纯字符串工具里依赖「可能不存在的原型方法」会让下载在旧版浏览器上直接抛错。
 * 自行按码元扫描是同一语义的最小实现，且不受运行时升级影响。
 * 语义对齐 ES2024 规范：孤立高位代理（后接非低位）与孤立低位代理都替换为 U+FFFD。
 */
const REPLACEMENT_CHAR = "�";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function wellFormedUtf16(value: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isHighSurrogate(code) && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
      i += 1; // 成对代理整体保留
      continue;
    }
    if (isHighSurrogate(code) || isLowSurrogate(code)) {
      out += value.slice(last, i) + REPLACEMENT_CHAR;
      last = i + 1;
    }
  }
  // 无孤立代理时原样返回同一字符串引用，避免无谓拷贝
  return last === 0 ? value : out + value.slice(last);
}
