/**
 * 上传失败遮罩：图片 / 视频 / 音频节点共用。
 *
 * 上传失败的占位节点会保留在画布上（不再自动删除），此处展示失败原因，
 * 并按错误的 retryable 决定是否给出「重试」入口——让用户不必重新裁剪 / 重新拖入。
 */
"use client";

import { CloseOutlined, ExclamationCircleOutlined, RedoOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { discardNodeUpload, retryNodeUpload } from "@/features/canvas/upload";
import type { UploadErrorInfo } from "@/lib/utils/upload";

interface Props {
  nodeId: string;
  error: UploadErrorInfo;
  /** 本地预览（blob:）：失败期间仍可展示，让用户知道失败的是哪个文件 */
  previewUrl?: string;
}

export default function UploadFailedOverlay({ nodeId, error, previewUrl }: Props) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);

  // 重试中：节点回到上传态后本组件会被卸载，这里只是按下按钮到状态切换之间的过渡
  if (retrying) {
    return (
      <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.45)" }}>
        <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await retryNodeUpload(nodeId);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{ filter: "blur(24px)", opacity: 0.45 }}
        />
      )}
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.55)" }} />
      <div className="relative z-10 flex flex-col items-center gap-2">
        <ExclamationCircleOutlined style={{ fontSize: 22, color: "#ff7875" }} />
        <span
          className="text-xs text-white/85"
          style={{
            maxWidth: 180,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {error.message}
        </span>
        <div className="flex items-center gap-2 mt-1">
          {error.retryable && (
            <button
              className="nodrag flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-500/90 hover:bg-blue-500 text-white text-xs cursor-pointer"
              onClick={() => void handleRetry()}
            >
              <RedoOutlined style={{ fontSize: 11 }} />
              {t("file.uploadRetry")}
            </button>
          )}
          <button
            className="nodrag flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/20 text-white/80 text-xs cursor-pointer"
            onClick={() => discardNodeUpload(nodeId)}
          >
            <CloseOutlined style={{ fontSize: 11 }} />
            {t("file.uploadDiscard")}
          </button>
        </div>
      </div>
    </div>
  );
}
