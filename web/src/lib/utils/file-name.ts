/**
 * 文件名清理工具：把任意用户文案（节点标题等）转成可安全用于下载 / 落盘的文件名。
 */

/** Windows / macOS 通用非法字符 */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
/** 控制字符（含换行、制表符）：会截断 HTTP 头，必须去掉 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
/** Windows 保留设备名：即便带扩展名也不可用（如 CON.txt） */
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
/** 主干长度上限（不含扩展名），兼顾各文件系统与展示 */
const MAX_LENGTH = 120;

/**
 * 清理文件名，避免用户把节点标题改成非法内容后下载 / 保存失败。
 *
 * 处理：控制字符与非法字符 → 折叠空白 → 去掉首尾的点与空格（Windows 不允许以此为结尾）
 * → 规避保留设备名 → 超长时截断主干并保留扩展名。
 * @returns 清理后的文件名；入参为空或全是非法字符时返回空串
 */
export function sanitizeFileName(name: string): string {
  if (!name) return "";

  const cleaned = name
    .replace(CONTROL_CHARS, "")
    .replace(ILLEGAL_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  if (!cleaned) return "";

  const dot = cleaned.lastIndexOf(".");
  // 末尾超过 10 字符（含点）就不认作扩展名：否则病态输入（一长串字符跟个点）
  // 会让「保留扩展名」的分支吃掉整个长度预算，长度限制形同虚设
  const hasExt = dot > 0 && dot < cleaned.length - 1 && cleaned.length - dot <= 11;
  const ext = hasExt ? cleaned.slice(dot) : "";
  let base = hasExt ? cleaned.slice(0, dot) : cleaned;

  if (RESERVED_NAMES.test(base)) base = `${base}_`;

  if (`${base}${ext}`.length > MAX_LENGTH) {
    base = base.slice(0, Math.max(1, MAX_LENGTH - ext.length)).replace(/[.\s]+$/, "");
  }

  return `${base}${ext}`;
}

/** 常见媒体扩展名白名单：label 去扩展名只认真媒体扩展，避免误伤含小数点的普通文案（如 "Scene 2.5 草稿"） */
const MEDIA_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|ico|mp4|webm|mov|avi|mkv|m4v|mp3|wav|ogg|flac|m4a|aac)$/i;

/** 去掉文件名末尾的媒体扩展名（仅命中白名单时），用于节点标题等展示场景 */
export function stripMediaExtension(name: string): string {
  return name.replace(MEDIA_EXTENSIONS, "");
}
