/**
 * 节点详情查看弹窗（调试用）。
 * 以只读方式展示选中节点的 ID、类型、坐标、尺寸及原始 JSON 数据。
 */
"use client";

import type { Node } from "@xyflow/react";

import Descriptions from "@/components/ui/descriptions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Paragraph } from "@/components/ui/typography";


interface NodeInspectorProps {
  open: boolean;
  node: Node | null;
  onClose: () => void;
}

export default function NodeInspector({ open, node, onClose }: NodeInspectorProps) {
  if (!node) return null;

  const jsonStr = JSON.stringify(
    { id: node.id, type: node.type, position: node.position, data: node.data, style: node.style },
    null,
    2
  );

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-1 grid-rows-[auto_minmax(0,1fr)] sm:max-w-[520px]">
        <DialogHeader className="min-w-0 pr-10">
          <DialogTitle className="line-clamp-2 break-words">{(node.data as { label?: string })?.label || node.id}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 min-w-0 space-y-3 overflow-y-auto overscroll-contain">
          <Descriptions column={1} size="sm" bordered items={[
            { key: "id", label: "ID", children: node.id },
            { key: "type", label: "Type", children: node.type },
            { key: "position", label: "Position", children: `x: ${Math.round(node.position.x)}, y: ${Math.round(node.position.y)}` },
            { key: "size", label: "Size", children: node.style?.width ? `${node.style.width} × ${node.style.height || "auto"}` : "default" },
          ]} />

          <div className="text-xs text-muted-foreground">Raw JSON:</div>
          <Paragraph
            copyable={{ text: jsonStr }}
            className="mb-0 max-h-[300px] min-w-0 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
          >{jsonStr}</Paragraph>
        </div>
      </DialogContent>
    </Dialog>
  );
}
