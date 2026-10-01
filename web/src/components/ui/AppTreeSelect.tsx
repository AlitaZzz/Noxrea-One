"use client";

import { TreeSelect } from "antd";
import type { CSSProperties, ReactNode } from "react";

export interface AppTreeNode { value: string; label: string; title: ReactNode; disabled?: boolean; children?: AppTreeNode[] }
export interface AppTreeSelectProps {
  value?: string | null;
  onChange?: (value: string | undefined) => void;
  nodes: AppTreeNode[];
  allowClear?: boolean;
  searchable?: boolean;
  onSearch?: (query: string) => void;
  expandAll?: boolean;
  popupHeight?: number;
  emptyContent?: ReactNode;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
}

function toNodes(nodes: AppTreeNode[]): AppTreeNode[] {
  return nodes.map((node) => ({ ...node, title: <span>{node.title}</span>, children: node.children ? toNodes(node.children) : undefined }));
}

export default function AppTreeSelect({ nodes, value, searchable, expandAll, popupHeight, emptyContent, ...props }: AppTreeSelectProps) {
  return <TreeSelect<string | null | undefined> {...props} value={value} onChange={(next) => props.onChange?.(next ?? undefined)} treeData={toNodes(nodes)} showSearch={searchable}
    treeDefaultExpandAll={expandAll} listHeight={popupHeight} notFoundContent={emptyContent} treeNodeFilterProp="label" />;
}
