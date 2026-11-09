/**
 * 文件引用值域（入库统一规则）。
 *
 * 持久化引用只允许两种形态：存储 key（`{userId}/{hash[:2]}/{hash}{ext}`）
 * 或外部 http(s) URL。data: / blob: 属渲染期预览形态（上传管道的 blob: 预览
 * 存于节点 upload.previewUrl，不进 src），不持久化、不入引用账本。
 * 判别实现单点在 shared 的 isFileRefValue（与 crud 层 fail-closed 防线共用）。
 */
import { z } from "zod";

import { isFileRefValue } from "@noxrea/shared/url";

export const fileRefSchema = z
  .string()
  .min(1)
  .refine(isFileRefValue, {
    message: "来源引用须为存储 key 或外部 http(s) URL",
  });

/**
 * 引用账本来源类型（`file_refs.source_type` 的业务值域）。
 * canvas_cover 是项目封面专用来源：与画布内容（canvas）正交——画布保存的
 * 整替集合每次覆盖 sourceId=项目 id 的引用，封面若混入会被冲掉。
 * avatar 是用户头像专用来源（sourceId=用户 id，每用户至多一行）：头像 key 不经
 * 画布/资产保存流程，须独立登记，否则头像对象账本无行会被 GC 当孤儿回收。
 */
export type FileRefSourceType = "canvas" | "canvas_cover" | "asset_item" | "avatar";

/** 文件引用数量表：key 是内容 SHA256，value 是节点/条目数量。 */
export type FileHashCounts = Map<string, number>;

/** 文件引用来源定位信息。 */
export interface FileRefSource {
  userId: number;
  sourceType: FileRefSourceType;
  sourceId: string;
}
