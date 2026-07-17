"use client";

import { Descriptions, Typography } from "antd";
import AppModal from "@/lib/app-modal";
import type { Node } from "@xyflow/react";

const { Paragraph } = Typography;

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
    <AppModal
      title={(node.data as { label?: string })?.label || node.id}
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
    >
      <Descriptions column={1} size="small" bordered className="mb-3">
        <Descriptions.Item label="ID">{node.id}</Descriptions.Item>
        <Descriptions.Item label="Type">{node.type}</Descriptions.Item>
        <Descriptions.Item label="Position">
          x: {Math.round(node.position.x)}, y: {Math.round(node.position.y)}
        </Descriptions.Item>
        <Descriptions.Item label="Size">
          {node.style?.width ? `${node.style.width} × ${node.style.height || "auto"}` : "default"}
        </Descriptions.Item>
      </Descriptions>

      <div className="text-xs text-zinc-500 mb-1">Raw JSON:</div>
      <Paragraph
        copyable
        className="text-xs"
        style={{
          background: "var(--canvas-bg-elevated, #353535)",
          padding: 8,
          borderRadius: 6,
          maxHeight: 300,
          overflow: "auto",
        }}
      >
        <pre className="m-0 text-xs whitespace-pre-wrap">{jsonStr}</pre>
      </Paragraph>
    </AppModal>
  );
}
