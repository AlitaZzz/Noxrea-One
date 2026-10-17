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
