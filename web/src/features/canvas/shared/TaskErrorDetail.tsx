/**
 * 生成任务失败通知的详情区。
 *
 * 上游返回的失败原因长度不可控：默认折叠为两行摘要，超出时提供「详情」展开完整文案，
 * 既避免长文本撑破通知框，又保证用户能拿到完整原文用于报障。
 */
"use client";

import { Typography } from "antd";
import { useTranslation } from "react-i18next";

/** 折叠状态下展示的行数 */
const SUMMARY_ROWS = 2;

export default function TaskErrorDetail({ message }: { message: string }) {
  const { t } = useTranslation();

  return (
    <Typography.Paragraph
      ellipsis={{ rows: SUMMARY_ROWS, expandable: true, symbol: t("generation.showDetail") }}
      // 保留上游原文中的换行，长单词/URL 强制断行避免溢出
      style={{ marginBottom: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    >
      {message}
    </Typography.Paragraph>
  );
}
