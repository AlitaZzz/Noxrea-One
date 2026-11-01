/**
 * 节点数据访问与 genSettings 投影（纯函数，不依赖 store）。
 *
 * 单独成模块是为了保持依赖方向：gen-settings（store 读写入口）→
 * gen-settings-normalize → ref-modes → ref-order，而 ref-order 也需要同一份
 * 「节点类型 → 生成能力」映射与 genSettings 投影。放在最底层，上下游都从这里
 * 取，避免重复定义，也避免 ref-order 反向依赖归一化模块。
 */

import type { AnyNode, GenSettings, MediaGenFields } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";
import type { ModelCapability } from "@/lib/types/models";

/** 生成面板节点类型 → 生成能力；新增生成节点类型只改这一处 */
const GEN_KIND_BY_NODE_TYPE: Partial<Record<string, ModelCapability>> = {
  [NODE_TYPE.IMAGE]: "image",
  [NODE_TYPE.VIDEO]: "video",
  [NODE_TYPE.TEXT]: "text",
};

/** 节点类型 → 生成能力；非生成面板节点返回 null */
export function genKindOfNode(node: Pick<AnyNode, "type">): ModelCapability | null {
  return GEN_KIND_BY_NODE_TYPE[node.type ?? ""] ?? null;
}

/**
 * 节点 genSettings 的唯一读取投影：data 形状断言只在这里出现一次。
 * 保留 `GenSettings` 联合类型，面板按各自类型收窄；归一化等需要按任意键
 * 读写的入口再显式收宽为 `Record<string, unknown>`。
 */
export function genSettingsOf(node: AnyNode | undefined): GenSettings | undefined {
  return (node?.data as MediaGenFields | undefined)?.genSettings;
}

/**
 * 媒体数据是否已有内容（src 非空）。
 *
 * 「src 非空 = 有内容」是占位框比例与工具条内容门槛共用的判据：交互写入
 * （applyRatioToNode）、画布级归一化与 NodeToolbar 都从这里取，避免同一规则
 * 在多处各自维护。
 */
export function mediaDataHasContent(data: { src?: string } | undefined): boolean {
  return Boolean(data?.src);
}

/** 媒体节点是否已有内容（src 非空） */
export function mediaNodeHasContent(node: AnyNode | undefined): boolean {
  // 节点 data 是联合类型，只有媒体成员带 src；断言收宽到本判据所需的字段
  return mediaDataHasContent(node?.data as { src?: string } | undefined);
}
