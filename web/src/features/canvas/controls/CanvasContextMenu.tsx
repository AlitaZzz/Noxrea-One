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

import { useReactFlow } from "@xyflow/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AppstoreOutlined, CopyOutlined, DeleteOutlined, ExpandOutlined, PartitionOutlined, PictureOutlined, PlusSquareOutlined, RedoOutlined, SelectOutlined, SnippetsOutlined, UndoOutlined, UploadOutlined, VideoCameraOutlined } from "@/components/ui/AppIcon";
import { TextIcon } from "@/components/ui/AppIcon";
import { WaveIcon } from "@/components/ui/AppIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
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

type CanvasMenuItem =
  | { type: "divider"; key?: string }
  | { key: string; label?: ReactNode; icon?: ReactNode; extra?: ReactNode; disabled?: boolean; danger?: boolean; children?: CanvasMenuItem[]; type?: "group" };

/** 菜单项右侧的快捷键由 shadcn DropdownMenuShortcut 统一渲染。 */
function renderMenuItems(items: CanvasMenuItem[], onSelect: (key: string) => void): ReactNode {
  return items.map((item, index) => {
    if (item.type === "divider") {
      return <DropdownMenuSeparator key={item.key ?? `divider-${index}`} />;
    }
    if (item.type === "group") {
      return (
        <DropdownMenuGroup key={item.key}>
          {item.label && <DropdownMenuLabel>{item.label}</DropdownMenuLabel>}
          {item.children && renderMenuItems(item.children, onSelect)}
        </DropdownMenuGroup>
      );
    }
    return (
      <DropdownMenuItem
        key={item.key}
        disabled={item.disabled}
        variant={item.danger ? "destructive" : "default"}
        onSelect={() => onSelect(item.key)}
      >
        {item.icon}
        <span className="min-w-0 flex-1">{item.label}</span>
        {item.extra && <DropdownMenuShortcut>{item.extra}</DropdownMenuShortcut>}
      </DropdownMenuItem>
    );
  });
}

export default function CanvasContextMenu(props: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
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

  /** 右键菜单「上传」：打开系统文件选择器，选中的文件按右键落点批量创建节点 */
  const handleUpload = async () => {
    const files = await pickFiles({ accept: "image/*,video/*,audio/*", multiple: true });
    if (files.length === 0) return;
    // x / y 是右键点击处的屏幕坐标，落点需转换为画布坐标
    await createNodesFromFiles(files, screenToFlowPosition({ x, y }));
  };

  /** 画布级操作：整理 + 重置视图，仅 canvas 上下文使用 */
  const canvasActions: CanvasMenuItem[] = [
    { type: "divider" },
    { key: "tidy", icon: <AppstoreOutlined />, label: t("canvas.tidy"), disabled: props.tidyDisabled },
    { key: "fit", icon: <ExpandOutlined />, label: t("canvas.fit") },
  ];

  /** 三种上下文的条目统一为 DropdownMenu items；key → 动作分发见 onMenuClick */
  const menuItems: CanvasMenuItem[] =
    kind === "create"
      ? [
          { key: "g-add", type: "group", label: t("node.add") },
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
            { key: "paste", icon: <SnippetsOutlined />, label: t("common.paste"), extra: modKey("V") },
            { key: "selectAll", icon: <SelectOutlined />, label: t("common.selectAll"), extra: modKey("A"), disabled: !hasNodes },
            ...canvasActions,
            { type: "divider" },
            { key: "undo", icon: <UndoOutlined />, label: t("common.undo"), extra: modKey("Z"), disabled: !canUndo },
            { key: "redo", icon: <RedoOutlined />, label: t("common.redo"), extra: modKey("Shift+Z"), disabled: !canRedo },
          ]
        : [
            { key: "copy", icon: <CopyOutlined />, label: t("common.copyNode"), extra: modKey("C"), disabled: !hasSelection },
            ...(singleImageSrc ? [{ key: "copyImage", icon: <PictureOutlined />, label: t("node.copyImage") }] : []),
            { key: "duplicate", icon: <PlusSquareOutlined />, label: t("common.duplicate"), extra: modKey("D"), disabled: !hasSelection },
            { key: "paste", icon: <SnippetsOutlined />, label: t("common.paste"), extra: modKey("V") },
            { type: "divider" },
            { key: "delete", icon: <DeleteOutlined />, label: t("common.delete"), extra: "Delete", disabled: !hasSelection },
          ];

  const onMenuClick = (key: string) => {
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
    <DropdownMenu
      key={`${kind}:${x}:${y}`}
      open={visible}
      modal={false}
      onOpenChange={(open) => { if (!open) hide(); }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: "fixed", left: x, top: y, width: 1, height: 1, pointerEvents: "none" }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-auto min-w-36">
        {renderMenuItems(menuItems, onMenuClick)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
