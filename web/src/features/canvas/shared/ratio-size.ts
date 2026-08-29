import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_DISPLAY_MAX } from "@/lib/constants";
import { computeNodeSize } from "@/lib/utils/image-utils";

/**
 * 面板比例选择 -> 空节点占位框跟随。
 *
 * 设计约定（与生成完成后的尺寸逻辑保持一致）：
 * - 仅当节点无内容（src 为空）时生效：面板的 ratio 语义是"下一次生成"的参数，
 *   节点已有内容时改比例会破坏现有图片的显示，故跳过；
 * - "adaptive" 表示自适应、无确定比例，跳过；
 * - 尺寸换算：比例长边归一到 NODE_DISPLAY_MAX 后走 computeNodeSize。
 *   computeNodeSize 只缩不放，虚拟自然尺寸必须先放大到长边 600，
 *   否则 1:1 / 2:3 / 4:3 等会落在原始小尺寸上（只有 16:9 / 9:16 正常）。
 *   这样所有比例的占位框长边统一 600，与生成结果落地尺寸规则一致。
 *
 * 切换动画：临时给节点 style 加 width/height transition，动画结束后移除，
 * 避免影响拖拽调整大小；连续切换时重置计时器保证动画连续。
 *
 * 通用解析任意 "W:H" 格式，未来新增比例无需修改此逻辑。
 */

const ANIM_MS = 200;
const transitionTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function applyRatioToNode(nodeId: string, ratio: string) {
  if (!ratio || ratio === "adaptive") return;
  const [w, h] = ratio.split(":").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return;
  if ((node.data as { src?: string }).src) return; // 已有内容不跟随

  // 长边归一到 NODE_DISPLAY_MAX，再走 computeNodeSize（补标题栏高度）
  const scale = NODE_DISPLAY_MAX / Math.max(w, h);
  const { width, height } = computeNodeSize(w * scale, h * scale);

  // 连续切换时重置上一个动画的清理计时器
  const prev = transitionTimers.get(nodeId);
  if (prev) clearTimeout(prev);

  // updateNodeData 的 style 是整体替换，需保留原 style 其余字段
  useCanvasStore.getState().updateNodeData(
    nodeId,
    {},
    {
      ...(node.style ?? {}),
      width,
      height,
      transition: `width ${ANIM_MS}ms ease, height ${ANIM_MS}ms ease`,
    },
    { skipHistory: true },
  );
  markDirtyImmediate();

  // 动画结束后移除 transition，拖拽调整大小不受影响
  transitionTimers.set(nodeId, setTimeout(() => {
    transitionTimers.delete(nodeId);
    const n = useCanvasStore.getState().nodes.find((x) => x.id === nodeId);
    if (!n) return;
    useCanvasStore.getState().updateNodeData(
      nodeId,
      {},
      { ...(n.style ?? {}), transition: undefined },
      { skipHistory: true },
    );
  }, ANIM_MS + 60));
}
