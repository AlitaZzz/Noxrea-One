/**
 * 纯文本 → 段落化富文本 HTML（Tiptap content 形态）。
 *
 * 画布三个文本回填入口（SSE 生成回填、Agent 工具写入、剪贴板粘贴）共用此单源，
 * 此前各持一份实现且转义集合 / <br> 写法 / 空段处理并行漂移。
 * 语义基准为剪贴板粘贴分支：按空行分段为 <p>，段内换行转 <br>，
 * 转义 & < > "（双引号必须转义，保证 content 序列化与撤销 diff 一致）。
 */
export function textToTiptapHtml(text: string): string {
  const escape = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map(escape).join("<br>")}</p>`)
    .join("");
}
