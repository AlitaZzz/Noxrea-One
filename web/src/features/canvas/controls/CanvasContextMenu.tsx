/**
 * 画布菜单（三种上下文共用同一个弹出容器）。
 *
 * - create：左键双击空白处唤起 → 新增各类节点
 * - canvas：右键空白处唤起     → 上传 / 粘贴 / 全选 / 整理 / 重置视图 / 撤销 / 重做
 * - node  ：右键节点上唤起     → 复制 / 删除
 *
 * 双击负责「创建」，右键负责「对已有内容的操作」，两者职责不重叠。
 * 编辑类动作统一取自 canvas-edit-actions，与键盘快捷键共用同一份实现。
 */
"use client";

import { AppstoreOutlined, CopyOutlined, DeleteOutlined, ExpandOutlined, PartitionOutlined, PictureOutlined, RedoOutlined, SelectOutlined, SnippetsOutlined, UndoOutlined, UploadOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { useReactFlow } from "@xyflow/react";
import { Popover } from "antd";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { MenuDivider, MenuItem } from "@/components/ui/MenuPopover";
import {
  copySelection,
  deleteSelection,
  pasteClipboard,
  redoAction,
  selectAllNodes,
  undoAction,
} from "@/features/canvas/shared/canvas-edit-actions";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import { createNodesFromFiles, pickFiles } from "@/features/canvas/upload";

interface Props {
  onAddText: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
  onAddAudio: () => void;
  onAddDirector: () => void;
  onTidy: () => void;
  /** 节点少于 2 个时整理无意义，置灰 */
  tidyDisabled: boolean;
  onResetView: () => void;
}

const GROUP_LABEL_STYLE = { padding: "2px 4px 0", fontSize: 11, color: "var(--canvas-text-muted)" } as const;
/** 菜单项右侧的快捷键标注样式 */
const SHORTCUT_STYLE = { fontSize: 11, color: "var(--canvas-text-muted)" } as const;

export default function CanvasContextMenu(props: Props) {
  const { t } = useTranslation();
  const { x, y, visible, kind, hide } = useContextMenuStore();
  // 菜单坐标是屏幕坐标，粘贴落点需要的是画布坐标
  const { screenToFlowPosition } = useReactFlow();

  // 编辑类菜单项的可用性：随画布选中态与画布剪贴板实时变化
  const hasSelection = useCanvasStore((s) => s.nodes.some((n) => n.selected));
  const hasNodes = useCanvasStore((s) => s.nodes.length > 0);
  const canPaste = useSelectionStore((s) => (s.clipboard?.nodes.length ?? 0) > 0);
  const canUndo = useHistoryStore((s) => s.undoStack.length > 0);
  const canRedo = useHistoryStore((s) => s.redoStack.length > 0);

  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * 菜单打开期间的关闭逻辑，对齐 Floating UI useDismiss / Radix DismissableLayer：
   * 非模态浮层不使用全屏遮罩——遮罩会挡住画布，使右键其他节点时事件落在遮罩上，
   * React Flow 的 onNodeContextMenu 收不到，只能关闭而无法直接切换菜单。
   * 改为在 document 捕获阶段监听 pointerdown，并配合「是否点在菜单内」的守卫判断。
   */
  useEffect(() => {
    if (!visible) return;

    const onPointerDown = (e: PointerEvent) => {
      // 右键交给 contextmenu 流程处理：由 React Flow 的 onPaneContextMenu /
      // onNodeContextMenu 决定是切换菜单还是关闭。若在此先关，会出现「关了又开」的闪烁
      // （pointerdown 与 contextmenu 不在同一批 React 更新中）。
      if (e.button === 2) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      hide();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 捕获阶段处理并阻断继续传播：避免同时触发画布 Escape 的「清除选中」
      // （use-canvas-keyboard 监听的是 window 冒泡阶段，晚于此处）
      e.stopPropagation();
      hide();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [visible, hide]);

  /** 右键菜单「上传」：打开系统文件选择器，选中的文件按右键落点批量创建节点 */
  const handleUpload = async () => {
    const files = await pickFiles({ accept: "image/*,video/*,audio/*", multiple: true });
    if (files.length === 0) return;
    // x / y 是右键点击处的屏幕坐标，落点需转换为画布坐标
    await createNodesFromFiles(files, screenToFlowPosition({ x, y }));
  };

  /** 画布级操作：整理 + 重置视图，仅 canvas 上下文使用 */
  const canvasActions = (
    <>
      <MenuDivider />
      <MenuItem dimmed={props.tidyDisabled} onClick={() => { props.onTidy(); hide(); }}><AppstoreOutlined /> {t("canvas.tidy")}</MenuItem>
      <MenuItem onClick={() => { props.onResetView(); hide(); }}><ExpandOutlined /> {t("canvas.fit")}</MenuItem>
    </>
  );

  return (
    <>
      <Popover
        // 位置或上下文变化时强制重建：rc-trigger 只在打开状态变化时计算一次对齐，
        // 无法感知 trigger 锚点（下面那个 1x1 span）的坐标变化。
        // 若不加 key，菜单已打开时右键新位置会出现「store 更新了但浮层停在原处」。
        key={`${kind}:${x}:${y}`}
        open={visible}
        trigger={[]}
        placement="bottomLeft"
        arrow={false}
        getPopupContainer={() => document.body}
        onOpenChange={(v) => { if (!v) hide(); }}
        styles={{ container: { padding: 0, background: "transparent" } }}
        content={
          <div ref={menuRef} className="menu-popover flex flex-col gap-0.5 rounded-lg shadow-xl" style={{ padding: 8 }}>
            {kind === "create" && (
              <>
                <div style={GROUP_LABEL_STYLE}>{t("node.add")}</div>
                <MenuItem onClick={() => { props.onAddText(); hide(); }}><TextIcon /> {t("node.text")}</MenuItem>
                <MenuItem onClick={() => { props.onAddImage(); hide(); }}><PictureOutlined /> {t("node.image")}</MenuItem>
                <MenuItem onClick={() => { props.onAddVideo(); hide(); }}><VideoCameraOutlined /> {t("node.video")}</MenuItem>
                <MenuItem onClick={() => { props.onAddAudio(); hide(); }}><WaveIcon /> {t("node.audio")}</MenuItem>
                <MenuItem onClick={() => { props.onAddDirector(); hide(); }}><PartitionOutlined /> {t("node.director")}</MenuItem>
              </>
            )}

            {kind === "canvas" && (
              <>
                <MenuItem onClick={() => { hide(); void handleUpload(); }}><UploadOutlined /> {t("common.upload")}</MenuItem>
                <MenuDivider />
                <MenuItem dimmed={!canPaste} iconRight={<span style={SHORTCUT_STYLE}>Ctrl+V</span>} onClick={() => { pasteClipboard(screenToFlowPosition({ x, y })); hide(); }}><SnippetsOutlined /> {t("common.paste")}</MenuItem>
                <MenuItem dimmed={!hasNodes} iconRight={<span style={SHORTCUT_STYLE}>Ctrl+A</span>} onClick={() => { selectAllNodes(); hide(); }}><SelectOutlined /> {t("common.selectAll")}</MenuItem>
                {canvasActions}
                <MenuDivider />
                <MenuItem dimmed={!canUndo} iconRight={<span style={SHORTCUT_STYLE}>Ctrl+Z</span>} onClick={() => { undoAction(); hide(); }}><UndoOutlined /> {t("common.undo")}</MenuItem>
                <MenuItem dimmed={!canRedo} iconRight={<span style={SHORTCUT_STYLE}>Ctrl+Shift+Z</span>} onClick={() => { redoAction(); hide(); }}><RedoOutlined /> {t("common.redo")}</MenuItem>
              </>
            )}

            {kind === "node" && (
              <>
                <MenuItem dimmed={!hasSelection} onClick={() => { copySelection(); hide(); }}><CopyOutlined /> {t("common.copy")}</MenuItem>
                <MenuItem dimmed={!hasSelection} onClick={() => { deleteSelection(); hide(); }}><DeleteOutlined /> {t("common.delete")}</MenuItem>
              </>
            )}
          </div>
        }
      >
        <span
          style={{
            position: "fixed",
            left: Math.min(x, window.innerWidth - 180),
            top: Math.min(y, window.innerHeight - 240),
            width: 1, height: 1, pointerEvents: "none",
          }}
        />
      </Popover>
    </>
  );
}
