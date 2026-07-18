"use client";

import { memo, useState, useCallback, useRef, useEffect } from "react";
import { Handle, Position } from "@xyflow/react";
import { Input } from "antd";
import { FontSizeOutlined } from "@ant-design/icons";
import type { TextNodeData } from "@/lib/types";
import { TEXT_NODE_MIN_WIDTH, TEXT_NODE_MIN_HEIGHT } from "@/lib/constants";
import ResizeHandle from "./ResizeHandle";
import { useI18nStore } from "@/stores/i18n-store";
import { EventNames } from "@/lib/eventNames";

interface TextNodeProps {
  id: string;
  data: TextNodeData;
  selected?: boolean;
}

function TextNode({ id, data, selected }: TextNodeProps) {
  useI18nStore((s) => s.lang);
  const t = useI18nStore((s) => s.t);
  const [content, setContent] = useState(data.content || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (selected && !content && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [selected, content]);

  const handleChange = useCallback(
    (value: string) => {
      setContent(value);
      window.dispatchEvent(
        new CustomEvent(EventNames.NODE_UPDATE_DATA, {
          detail: { nodeId: id, data: { ...data, content: value } },
        })
      );
    },
    [id, data]
  );

  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title tab */}
      <div
        className={`
          flex items-center px-3 py-1 text-[13px] font-medium text-white/80 z-10
        `}
      >
        <FontSizeOutlined className="mr-1" />
        <Input
          size="small"
          variant="borderless"
          className="text-[13px] font-medium text-white/80"
          value={data.label}
          onChange={(e) =>
            window.dispatchEvent(
              new CustomEvent(EventNames.NODE_UPDATE_DATA, {
                detail: { nodeId: id, data: { ...data, label: e.target.value || t("text.node") } },
              })
            )
          }
          style={{ padding: "1px 4px", height: 20, background: "var(--canvas-bg)", border: "1px solid #525252", borderRadius: 4, outline: "none", boxShadow: "none" }}
        />
      </div>

      {/* Body */}
      <div
        className={`
          flex-1 flex flex-col overflow-hidden rounded-lg border
          ${selected ? "border-white/30 shadow-lg" : "border-white/10"}
        `}
        style={{ background: "var(--canvas-bg, #262626)" }}
      >
        <textarea
          ref={textareaRef}
          className="flex-1 w-full resize-none border-none outline-none p-3 text-sm text-white/80 placeholder:text-white/20"
          style={{ background: "transparent" }}
          placeholder="Write your prompt or notes here..."
          value={content}
          onChange={(e) => handleChange(e.target.value)}
        />
      </div>

      {selected && (
        <ResizeHandle nodeId={id} corner="bottom-right" minWidth={TEXT_NODE_MIN_WIDTH} minHeight={TEXT_NODE_MIN_HEIGHT} />
      )}

      <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: "#1677ff" }} />
      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: "#1677ff" }} />
    </div>
  );
}

export default memo(TextNode);
