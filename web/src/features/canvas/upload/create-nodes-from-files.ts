/**
 * 把本地文件作为「新节点」批量落到画布并走统一上传管道。
 *
 * 与「拖入画布」共用同一份落位逻辑：先本地探测图片 / 视频自然尺寸，再按正确
 * 尺寸做网格排布，最后交给 runMediaUpload（create-node sink）建占位节点、
 * 并发上传、成功落库 / 失败移除并提示。
 *
 * 供右键菜单「上传」与 use-file-drop 拖放两个入口复用。
 */

import {
  AUDIO_NODE_HEIGHT,
  AUDIO_NODE_WIDTH,
  DEFAULT_NODE_CONTENT_HEIGHT,
  DEFAULT_NODE_WIDTH,
  LAYOUT_GAP,
} from "@/lib/constants";
import { computeNodeSize, loadMediaDimensions } from "@/lib/utils/image-utils";
import { isOffline } from "@/lib/utils/upload";

import { detectMediaKind, runMediaUpload } from "./upload-pipeline";
import type { UploadItem } from "./types";

/** 网格列数：多文件拖入 / 上传时按此列数换行排布 */
const GRID_COLS = 4;

/**
 * 按统一管道把多个本地文件创建为画布节点，落点以 origin 为左上角起点做网格排布。
 *
 * @param files  待上传的本地文件
 * @param origin 落点起点（画布坐标），后续文件按网格向右 / 向下依次排开
 */
export async function createNodesFromFiles(
  files: File[],
  origin: { x: number; y: number },
): Promise<void> {
  if (files.length === 0) return;

  const items: UploadItem[] = [];
  // 网格落点游标：按每个文件的实际显示尺寸逐行累加（行满 GRID_COLS 换行），
  // 任意比例混合时间距恒为 LAYOUT_GAP 且互不遮挡
  let cursorX = origin.x;
  let cursorY = origin.y;
  let rowMaxH = 0;
  let colInRow = 0;

  for (const file of files) {
    const kind = detectMediaKind(file, file.name);
    // 不支持的类型原样交给管道，由它统一计数并提示
    if (!kind) {
      items.push({ blob: file, filename: file.name });
      continue;
    }

    let previewUrl: string | undefined;
    let nw = 0;
    let nh = 0;
    let nodeW = AUDIO_NODE_WIDTH;
    let nodeH = AUDIO_NODE_HEIGHT;

    // 离线时 runMediaUpload 会立即以「离线」语义返回，不会接管任何预览 URL，
    // 因此这里也不创建，避免 blob URL 无人 revoke 而泄漏（此情况下尺寸探测也无意义）
    if (kind !== "audio" && !isOffline()) {
      previewUrl = URL.createObjectURL(file);
      const dims = await loadMediaDimensions(previewUrl, kind === "video");
      nw = dims.w || (kind === "video" ? 1280 : DEFAULT_NODE_WIDTH);
      nh = dims.h || (kind === "video" ? 720 : DEFAULT_NODE_CONTENT_HEIGHT);
      const { width, height } = computeNodeSize(nw, nh);
      nodeW = width;
      nodeH = height;
    }

    // 行满换行：y 前进一行（行高 = 该行最大节点高度 + 间距）
    if (colInRow >= GRID_COLS) {
      cursorX = origin.x;
      cursorY += rowMaxH + LAYOUT_GAP;
      rowMaxH = 0;
      colInRow = 0;
    }

    // 落点 = 当前游标；游标按实际尺寸前进
    items.push({
      blob: file,
      filename: file.name,
      nodeType: kind,
      naturalWidth: nw,
      naturalHeight: nh,
      previewUrl,
      position: { x: cursorX, y: cursorY },
    });

    cursorX += nodeW + LAYOUT_GAP;
    rowMaxH = Math.max(rowMaxH, nodeH);
    colInRow++;
  }

  // 交给统一上传管道：建占位 → 并发上传 → 成功落库 / 失败移除并提示
  await runMediaUpload({ items, sink: { kind: "create-node" } });
}