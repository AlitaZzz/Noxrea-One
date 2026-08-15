/**
 * 节点类型的展示元数据（display meta）。
 * 集中定义各节点类型的 i18n 文案 key、面板排序、语义色与图标工厂函数。
 *
 * 语义色统一引用 lib/constants 的 NODE_TYPE_COLOR（小地图与节点 handle 同源），
 * 避免历史上 TYPE_COLORS 与 NODE_TYPE_COLOR 并存的双数据源问题。
 */
import { GroupOutlined, PartitionOutlined, PictureOutlined, VideoCameraOutlined } from "@ant-design/icons";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { NODE_TYPE, NODE_TYPE_COLOR } from "@/lib/constants";

/** 节点类型 -> i18n key 映射 */
export const NODE_TYPE_I18N: Record<string, string> = {
  [NODE_TYPE.DIRECTOR]: "node.director",
  [NODE_TYPE.IMAGE]: "node.image",
  [NODE_TYPE.VIDEO]: "node.video",
  [NODE_TYPE.TEXT]: "node.text",
  [NODE_TYPE.GROUP]: "node.group",
  [NODE_TYPE.AUDIO]: "node.audio",
};

/** 节点类型在侧边栏中的显示顺序 */
export const NODE_TYPE_ORDER = [
  NODE_TYPE.DIRECTOR,
  NODE_TYPE.IMAGE,
  NODE_TYPE.VIDEO,
  NODE_TYPE.TEXT,
  NODE_TYPE.AUDIO,
  NODE_TYPE.GROUP,
];

/** 根据节点类型获取语义色（取自单一数据源 NODE_TYPE_COLOR） */
export function getNodeTypeColor(type: string): string {
  return NODE_TYPE_COLOR[type] || "var(--canvas-text-dim)";
}

/** 根据节点类型获取图标组件 */
export function getNodeTypeIcon(type: string) {
  const color = getNodeTypeColor(type);
  const s = { fontSize: 18, color };
  switch (type) {
    case NODE_TYPE.TEXT:     return <TextIcon style={s} />;
    case NODE_TYPE.IMAGE:    return <PictureOutlined style={s} />;
    case NODE_TYPE.VIDEO:    return <VideoCameraOutlined style={s} />;
    case NODE_TYPE.DIRECTOR: return <PartitionOutlined style={s} />;
    case NODE_TYPE.GROUP:    return <GroupOutlined style={s} />;
    case NODE_TYPE.AUDIO:    return <WaveIcon style={s} />;
    default:                 return <PictureOutlined style={s} />;
  }
}
