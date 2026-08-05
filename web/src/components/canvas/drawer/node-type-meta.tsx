/**
 * 节点类型的展示元数据（display meta）。
 * 集中定义各节点类型的 i18n 文案 key、面板排序、语义色与图标工厂函数。
 */
import { GroupOutlined, PartitionOutlined, PictureOutlined, VideoCameraOutlined } from "@ant-design/icons";

import { WaveIcon } from "@/components/common/icons/media/WaveIcon";
import { TextIcon } from "@/components/common/icons/media/TextIcon";
import { NODE_TYPE } from "@/lib/constants";

/** 节点类型 -> i18n key 映射 */
export const NODE_TYPE_I18N: Record<string, string> = {
  [NODE_TYPE.DIRECTOR]: "director.node",
  [NODE_TYPE.IMAGE]: "image.node",
  [NODE_TYPE.VIDEO]: "video.node",
  [NODE_TYPE.TEXT]: "text.node",
  [NODE_TYPE.GROUP]: "group.node",
  [NODE_TYPE.AUDIO]: "audio.node",
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

/** 节点类型 -> 语义色 */
export const TYPE_COLORS: Record<string, string> = {
  [NODE_TYPE.DIRECTOR]: "#ff8a3d",
  [NODE_TYPE.IMAGE]: "#52c41a",
  [NODE_TYPE.VIDEO]: "#13c2c2",
  [NODE_TYPE.TEXT]: "#1677ff",
  [NODE_TYPE.GROUP]: "#722ed1",
  [NODE_TYPE.AUDIO]: "#fa8c16",
};

/** 根据节点类型获取图标组件 */
export function getNodeTypeIcon(type: string) {
  const color = TYPE_COLORS[type] || "var(--canvas-text-dim)";
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
