/**
 * TreeSelect 搜索态：hook 只管查询词状态，splitMatch 做命中拆分（纯数据），
 * JSX 高亮由组件在调用处渲染（逻辑与渲染分离，hook 保持零渲染关注点）。
 */
import { useCallback, useState } from "react";

export interface TreeMatch {
  pre: string;
  hit: string;
  post: string;
}

/** 大小写不敏感地把 name 拆成 [前段, 命中片段, 后段]；无命中（含查询词为空）返回 null。 */
export function splitMatch(name: string, query: string): TreeMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const idx = name.toLowerCase().indexOf(q);
  if (idx < 0) return null;
  return { pre: name.slice(0, idx), hit: name.slice(idx, idx + q.length), post: name.slice(idx + q.length) };
}

export function useTreeMatchTitle() {
  const [query, setQuery] = useState("");
  const reset = useCallback(() => setQuery(""), []);
  return { query, onSearch: setQuery, reset };
}
