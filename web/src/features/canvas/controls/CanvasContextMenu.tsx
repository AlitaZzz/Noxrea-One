/**
 * 画布菜单（三种上下文共用同一个弹出容器）。
 *
 * - create：左键双击空白处唤起 → 新增各类节点
 * - canvas：右键空白处唤起     → 上传 / 粘贴 / 全选 / 整理 / 重置视图 / 撤销 / 重做
 * - node  ：右键节点上唤起     → 复制 / 复制图片（单选图片节点）/ 创建副本 / 粘贴 / 删除
 *
 * 双击负责「创建」，右键负责「对已有内容的操作」，两者职责不重叠。
 * 编辑类动作统一取自 canvas-edit-actions，与键盘快捷键共用同一份实现。
 */
"use client";

import { AppstoreOutlined, CopyOutlined, DeleteOutlined, ExpandOutlined, PartitionOutlined, PictureOutlined, PlusSquareOutlined, RedoOutlined, SelectOutlined, SnippetsOutlined, UndoOutlined, UploadOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { useReactFlow } from "@xyflow/react";
import type { MenuProps } from "antd";
import { App, Menu, Popover } from "antd";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import {
  copyImageSrcToClipboard,
  copySelection,
  deleteSelection,
  duplicateSelection,
  pasteClipboard,
  pasteFromClipboardContent,
  readSystemClipboard,
  redoAction,
  selectAllNodes,
  undoAction,
} from "@/features/canvas/shared/canvas-edit-actions";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import { createNodesFromFiles, pickFiles } from "@/features/canvas/upload";
import { NODE_TYPE } from "@/lib/constants";
import { MOD_KEY,modKey } from "@/lib/platform";

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

const GROUP_LABEL_STYLE = { padding: "2px 4px 0", fontSize: 12, color: "var(--canvas-text-muted)" } as const;
/** 菜单项右侧的快捷键标注样式 */
const SHORTCUT_STYLE = { fontSize: 12, color: "var(--canvas-text-muted)" } as const;

export default function CanvasContextMenu(props: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { x, y, visible, kind, hide } = useContextMenuStore();
  // 菜单坐标是屏幕坐标，粘贴落点需要的是画布坐标
  const { screenToFlowPosition } = useReactFlow();

  // 编辑类菜单项的可用性：随画布选中态实时变化（粘贴不置灰：内部剪贴板为空时
  // 会主动读取系统剪贴板，无法在菜单打开时廉价预判系统剪贴板内容）
  const hasSelection = useCanvasStore((s) => s.nodes.some((n) => n.selected));
  const hasNodes = useCanvasStore((s) => s.nodes.length > 0);
  const canUndo = useHistoryStore((s) => s.undoStack.length > 0);
  const canRedo = useHistoryStore((s) => s.redoStack.length > 0);
  // 单选图片节点时的 src：右键菜单据此显示「复制图片」（位图进系统剪贴板）。
  // 空 src（新建未生成的占位节点）视为无图，不显示该项
  const singleImageSrc = useCanvasStore((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    if (sel.length !== 1 || sel[0].type !== NODE_TYPE.IMAGE) return null;
    return (sel[0].data as { src?: string }).src || null;
  });

  /** 右键菜单「复制图片」：节点图片转 PNG 写入系统剪贴板，可贴到画布外应用 */
  const handleCopyImage = async () => {
    hide();
    if (!singleImageSrc) return;
    const ok = await copyImageSrcToClipboard(singleImageSrc);
    message.success(ok ? t("common.copied") : t("common.copyFailed"));
  };

  /** 右键菜单「粘贴」：内部剪贴板优先；为空时主动读取系统剪贴板走智能粘贴
      （clipboard.read 需浏览器一次授权，Firefox 降级 readText 只取文本） */
  const handleMenuPaste = async () => {
    hide();
    const at = screenToFlowPosition({ x, y });
    if ((useSelectionStore.getState().clipboard?.nodes.length ?? 0) > 0) {
      pasteClipboard(at);
      return;
    }
    const content = await readSystemClipboard();
    if (!content) {
      message.info(t("common.clipboardReadFailed", { mod: MOD_KEY }));
      return;
    }
    if (!pasteFromClipboardContent(content, at)) {
      message.info(t("common.pasteUnsupported"));
    }
  };

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
  const canvasActions: MenuProps["items"] = [
    { type: "divider" },
    { key: "tidy", icon: <AppstoreOutlined />, label: t("canvas.tidy"), disabled: props.tidyDisabled },
    { key: "fit", icon: <ExpandOutlined />, label: t("canvas.fit") },
  ];

  /** 三种上下文的条目统一为 antd Menu items；key → 动作分发见 onMenuClick */
  const menuItems: MenuProps["items"] =
    kind === "create"
      ? [
          { key: "g-add", type: "group", label: <div style={GROUP_LABEL_STYLE}>{t("node.add")}</div> },
          { key: "add-text", icon: <TextIcon />, label: t("node.text") },
          { key: "add-image", icon: <PictureOutlined />, label: t("node.image") },
          { key: "add-video", icon: <VideoCameraOutlined />, label: t("node.video") },
          { key: "add-audio", icon: <WaveIcon />, label: t("node.audio") },
          { key: "add-director", icon: <PartitionOutlined />, label: t("node.director") },
        ]
      : kind === "canvas"
        ? [
            { key: "upload", icon: <UploadOutlined />, label: t("common.upload") },
            { type: "divider" },
            { key: "paste", icon: <SnippetsOutlined />, label: t("common.paste"), extra: <span style={SHORTCUT_STYLE}>{modKey("V")}</span> },
            { key: "selectAll", icon: <SelectOutlined />, label: t("common.selectAll"), extra: <span style={SHORTCUT_STYLE}>{modKey("A")}</span>, disabled: !hasNodes },
            ...canvasActions,
            { type: "divider" },
            { key: "undo", icon: <UndoOutlined />, label: t("common.undo"), extra: <span style={SHORTCUT_STYLE}>{modKey("Z")}</span>, disabled: !canUndo },
            { key: "redo", icon: <RedoOutlined />, label: t("common.redo"), extra: <span style={SHORTCUT_STYLE}>{modKey("Shift+Z")}</span>, disabled: !canRedo },
          ]
        : [
            { key: "copy", icon: <CopyOutlined />, label: t("common.copyNode"), extra: <span style={SHORTCUT_STYLE}>{modKey("C")}</span>, disabled: !hasSelection },
            ...(singleImageSrc ? [{ key: "copyImage", icon: <PictureOutlined />, label: t("node.copyImage") }] : []),
            { key: "duplicate", icon: <PlusSquareOutlined />, label: t("common.duplicate"), extra: <span style={SHORTCUT_STYLE}>{modKey("D")}</span>, disabled: !hasSelection },
            { key: "paste", icon: <SnippetsOutlined />, label: t("common.paste"), extra: <span style={SHORTCUT_STYLE}>{modKey("V")}</span> },
            { type: "divider" },
            { key: "delete", icon: <DeleteOutlined />, label: t("common.delete"), extra: <span style={SHORTCUT_STYLE}>Delete</span>, disabled: !hasSelection },
          ];

  const onMenuClick = ({ key }: { key: string }) => {
    switch (key) {
      case "add-text": props.onAddText(); hide(); break;
      case "add-image": props.onAddImage(); hide(); break;
      case "add-video": props.onAddVideo(); hide(); break;
      case "add-audio": props.onAddAudio(); hide(); break;
      case "add-director": props.onAddDirector(); hide(); break;
      case "upload": hide(); void handleUpload(); break;
      case "paste": void handleMenuPaste(); break;
      case "selectAll": selectAllNodes(); hide(); break;
      case "tidy": props.onTidy(); hide(); break;
      case "fit": props.onResetView(); hide(); break;
      case "undo": undoAction(); hide(); break;
      case "redo": redoAction(); hide(); break;
      case "copy": copySelection(); hide(); break;
      case "copyImage": void handleCopyImage(); break;
      case "duplicate": duplicateSelection(); hide(); break;
      case "delete": deleteSelection(); hide(); break;
    }
  };

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
          <div ref={menuRef} className="panel-popover">
            <Menu
              items={menuItems}
              onClick={onMenuClick}
              selectable={false}
              style={{ border: 0, background: "transparent", minWidth: 148 }}
            />
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
