/**
 * Agent 对话用的 Markdown 渲染容器。
 * 经 sanitize 白名单放宽后允许有限 HTML（表格 / details / 带内联样式等）。
 */
"use client";

import type { Schema } from "hast-util-sanitize";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/** 允许 AI 输出中嵌入的 HTML 标签与属性，在 defaultSchema 基础上放宽 */
export const sanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style", "className", "class"],
    div: ["style", "className", "class"],
    span: ["style", "className", "class"],
    table: ["style", "className", "class"],
    td: ["colspan", "rowspan", "style", "class"],
    th: ["colspan", "rowspan", "style", "class"],
    img: ["src", "alt", "width", "height", "style", "class"],
    a: ["href", "target", "rel", "style", "class"],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div", "span", "table", "thead", "tbody", "tr", "td", "th",
    "details", "summary", "figure", "figcaption",
  ],
};

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="cortex-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
