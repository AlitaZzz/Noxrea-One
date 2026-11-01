/**
 * 生成面板参考区 chrome：参考分组、加号上传入口与参考拖放的落点门控。
 *
 * 三个生成面板的参考区结构完全一致，只有分组内容不同；面板隐藏时整组卸载
 * （Radix 浮层随之关闭、参考卡片停止媒体订阅），只保留编辑器实例与内容。
 * 拖放门控只放行同类缩略图上的排序：参考拖放落到加号/空白处一律拒绝。
 */
"use client";

import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PlusOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** 参考卡片拖拽使用的私有 MIME 类型（见 shared/ImageRefCard 等卡片组件） */
const REF_DRAG_MIME_TYPES = new Set([
  "application/x-ref-image",
  "application/x-ref-video",
  "application/x-ref-audio",
  "application/x-ref-text",
]);

export interface GenerationRefGroup {
  key: string;
  content: ReactNode;
}

interface Props {
  /** 面板当前是否可见：隐藏时整组卸载，只保留编辑器 */
  active: boolean;
  groups: readonly GenerationRefGroup[];
  onUpload: () => void;
}

export default function GenerationRefChrome({ active, groups, onUpload }: Props) {
  const { t } = useTranslation();
  if (!active) return null;
  return (
    <div
      className="flex gap-2 flex-wrap"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // 排序仅限同类缩略图上，加号/空白一律禁止
        const hasRef = e.dataTransfer.types.some((type) => REF_DRAG_MIME_TYPES.has(type));
        e.dataTransfer.dropEffect = hasRef ? "none" : "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* 参考区按类型分组：文本 → 音频 → 图片 → 视频，组间以竖线分隔 */}
      {groups.map((group, i) => (
        <Fragment key={group.key}>
          {i > 0 && <Separator orientation="vertical" className="mx-1 h-14 self-center" />}
          {group.content}
        </Fragment>
      ))}
      {/* 添加参考：方形加号占位，与参考缩略图同行 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-14 shrink-0 rounded-md border-dashed p-0"
            onClick={onUpload}
          >
            <PlusOutlined className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("common.reference")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
