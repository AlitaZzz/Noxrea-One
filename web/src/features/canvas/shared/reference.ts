/**
 * @ 引用素材的数据契约。
 * 定义引用项结构与提示词中的存储格式（不含 UI），
 * 供各生成面板、提示词输入框与 chip 节点共用。
 */

export interface ReferenceItem {
  src: string;
  thumbnail: string;
  index: number; // 0-based index within its kind list
  kind: "image" | "audio" | "video" | "preset";
  label?: string; // audio/video label (filename), unused for images
  /** kind === "preset" 时必填：预设 id（对应 prompt-template.json 的 key），chip 无 src */
  presetId?: string;
}

/** mention 节点 attrs 的存储形态：ReferenceItem 去掉 label（attrs 由 Tiptap addAttributes 声明，无 label 字段） */
export type ReferenceItemAttrs = Omit<ReferenceItem, 'label'>;

/** 引用项 chip 标签：图片N / 音频N / 视频N。
 *  这是提示词的存储/回传格式（MentionPrompt 序列化与往返解析依赖它），
 *  必须跨语言稳定——随 locale 变化会让已存提示词与解析对不上。
 *  UI 展示一律走 refLabelKey + t()（见 MentionChip / MentionDropdown）。 */
export function refLabel(item: ReferenceItem): string {
  const prefix = item.kind === "audio" ? "音频" : item.kind === "video" ? "视频" : "图片";
  return `${prefix}${item.index + 1}`;
}

/** 引用项全称词条 key：图片N / 音频N / 视频N（与参考区缩略图标签一致） */
export function refLabelKey(item: ReferenceItem): string {
  return item.kind === "audio"
    ? "common.refAudioLabel"
    : item.kind === "video"
      ? "common.refVideoLabel"
      : "common.refImageLabel";
}
