"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { useRouter } from "next/navigation";
import { CameraOutlined } from "@ant-design/icons";
import { useI18nStore } from "@/stores/i18n-store";

interface Props {
  id: string;
  data: { label?: string };
  selected?: boolean;
}

function DirectorNode({ id, data, selected }: Props) {
  const t = useI18nStore((s) => s.t);
  const router = useRouter();

  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title */}
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80">
        <span className="truncate cursor-default">
          <CameraOutlined className="mr-1" />
          {data.label || t("director.node")}
        </span>
      </div>

      {/* Body */}
      <div className={`flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
        ${selected ? "outline outline-1 outline-white/30 shadow-lg" : "outline outline-1 outline-white/10"}`}
        style={{ background: "var(--canvas-bg)" }}>
        <div className="flex flex-col items-center justify-center gap-3 p-4 text-white/40">
          <CameraOutlined className="text-5xl" />
          <span className="text-base text-center">{t("director.desc")}</span>
          <button className="node-upload-btn nodrag flex items-center gap-2 px-6 py-3 rounded-lg text-base"
            onClick={() => router.push("/director")}>
            {t("director.open")}
          </button>
        </div>
      </div>

      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: "#ff8a3d" }} />
    </div>
  );
}

export default memo(DirectorNode);
