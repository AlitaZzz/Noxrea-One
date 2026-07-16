"use client";

import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Tooltip } from "antd";
import { LayerModal } from "@/lib/layer";
import { DownloadOutlined, ExpandOutlined, PictureOutlined } from "@ant-design/icons";
import type { ImageGroupNodeData } from "@/lib/types";
import ResizeHandle from "./ResizeHandle";
import { useI18nStore } from "@/stores/i18n-store";

interface Props { id: string; data: ImageGroupNodeData; selected?: boolean; }

function ImageGroupNode({ id, data, selected }: Props) {
  useI18nStore((s) => s.lang);
  const t = useI18nStore((s) => s.t);
  const [mainIdx, setMainIdx] = useState(data.mainIndex || 0);
  const [expanded, setExpanded] = useState(false);
  const images = data.images || [];
  const main = images[mainIdx];

  const handleSetMain = (idx: number) => {
    setMainIdx(idx);
    window.dispatchEvent(new CustomEvent("node:update-data", { detail: { nodeId: id, data: { ...data, mainIndex: idx }, immediate: true } }));
  };

  const handleDownload = async (url: string) => {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = "image.png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }
    } catch {}
  };

  return (
    <div className={`group relative w-full h-full flex flex-col rounded-lg border ${selected ? "border-white/30 shadow-lg" : "border-white/10"}`}>
      <div className="flex items-center justify-between px-3 py-1 text-xs font-medium text-white/80 border-b border-white/10">
        <span><PictureOutlined className="mr-1" />{data.label || `Results (${images.length})`}</span>
        <button className="text-white/40 hover:text-white" onClick={() => setExpanded(true)}><ExpandOutlined /></button>
      </div>

      {/* Stacked cards */}
      <div className="flex-1 relative overflow-hidden" style={{ background: "var(--canvas-bg)", minHeight: 120 }}>
        {images.slice(0, 5).reverse().map((img, i) => {
          const idx = images.length - 1 - i;
          const isMain = idx === mainIdx;
          return (
            <div key={idx}
              className="absolute inset-2 transition-all duration-200 cursor-pointer hover:z-20"
              style={{
                zIndex: isMain ? 10 : 5 - i,
                transform: isMain ? "none" : `translate(${(5 - i) * -3}px, ${(5 - i) * -3}px) rotate(${(5 - i) * -1}deg)`,
                opacity: isMain ? 1 : 0.7 + (i * 0.05),
              }}
              onClick={() => handleSetMain(idx)}>
              <div className="w-full h-full rounded-lg overflow-hidden border-2 border-white/10" style={{ background: "var(--canvas-bg-elevated)" }}>
                <img src={img.url} alt={img.label} className="w-full h-full object-cover" />
              </div>
            </div>
          );
        })}
        {images.length > 5 && (
          <div className="absolute bottom-2 right-2 z-20 bg-black/60 text-white/60 text-[10px] px-1.5 py-0.5 rounded">+{images.length - 5}</div>
        )}
      </div>

      {selected && <ResizeHandle nodeId={id} corner="bottom-right" minWidth={160} minHeight={120} />}
      <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: "#52c41a" }} />
      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: "#52c41a" }} />

      {/* Expand modal */}
      <LayerModal open={expanded} onCancel={() => setExpanded(false)} footer={null} width={800} title={data.label || t("results")}
        styles={{ header: { background: "var(--canvas-bg)", borderBottom: "1px solid var(--canvas-border)" }, body: { background: "var(--canvas-bg)" } }}>
        <div className="grid grid-cols-3 gap-3 max-h-[500px] overflow-auto">
          {images.map((img, idx) => (
            <div key={idx} className={`relative rounded-lg overflow-hidden border-2 ${idx === mainIdx ? "border-blue-500" : "border-white/10"} cursor-pointer`}
              style={{ background: "var(--canvas-bg-elevated)" }} onClick={() => { handleSetMain(idx); setExpanded(false); }}>
              <img src={img.url} alt={img.label} className="w-full h-32 object-cover" />
              <div className="absolute top-1 right-1 flex gap-1 opacity-0 hover:opacity-100 transition-opacity">
                <Tooltip title="Download"><button className="w-6 h-6 flex items-center justify-center rounded bg-black/50 text-white/80" onClick={(e) => { e.stopPropagation(); handleDownload(img.url); }}><DownloadOutlined /></button></Tooltip>
              </div>
              <div className="px-2 py-1 text-[10px] text-white/50 truncate">{img.label}</div>
            </div>
          ))}
        </div>
      </LayerModal>
    </div>
  );
}

export default memo(ImageGroupNode);
