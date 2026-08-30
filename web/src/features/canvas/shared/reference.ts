/**
 * @ 引用素材的数据契约。
 * 定义引用项结构与提示词中的存储格式（不含 UI），
 * 供各生成面板、提示词输入框与 chip 节点共用。
 */

export interface ReferenceItem {
  src: string;
  thumbnail: string;
  index: number; // 0-based index within its kind list
  kind: "image" | "audio" | "video";
  label?: string; // audio/video label (filename), unused for images
}

/** 引用项 chip 标签：图片N / 音频N / 视频N（同时作为提示词存储格式） */
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
