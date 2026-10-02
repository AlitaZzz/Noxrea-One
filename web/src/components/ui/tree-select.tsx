"use client";

import { type CSSProperties, type ReactNode, useMemo, useState } from "react";

import { ChevronDownIcon, CloseOutlined, RightOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface TreeNode { value: string; label: string; title: ReactNode; disabled?: boolean; children?: TreeNode[] }
export interface TreeSelectProps {
  value?: string | null;
  onChange?: (value: string | undefined) => void;
  nodes: TreeNode[];
  allowClear?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  onSearch?: (query: string) => void;
  expandAll?: boolean;
  popupHeight?: number;
  emptyContent?: ReactNode;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flatten(node.children) : [])]);
}

function collectBranchValues(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.value, ...(node.children ? collectBranchValues(node.children) : [])]);
}

function filterNodes(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query.trim()) return nodes;
  const normalized = query.trim().toLocaleLowerCase();
  return nodes.flatMap((node) => {
    const children = node.children ? filterNodes(node.children, query) : [];
    return node.label.toLocaleLowerCase().includes(normalized) || children.length ? [{ ...node, children }] : [];
  });
}

export function TreeSelect({
  nodes,
  value,
  onChange,
  allowClear = false,
  searchable = false,
  searchPlaceholder,
  onSearch,
  expandAll = false,
  popupHeight = 256,
  emptyContent,
  placeholder,
  className,
  style,
}: TreeSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandAll ? collectBranchValues(nodes) : []));
  const selected = useMemo(() => flatten(nodes).find((node) => node.value === value), [nodes, value]);
  const visibleNodes = useMemo(() => filterNodes(nodes, query), [nodes, query]);

  const select = (node: TreeNode) => {
    if (node.disabled) return;
    onChange?.(node.value);
    setOpen(false);
  };
  const toggleExpanded = (node: TreeNode) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(node.value)) next.delete(node.value); else next.add(node.value);
      return next;
    });
  };

  const renderNodes = (items: TreeNode[], depth = 0): ReactNode => items.map((node) => {
    const hasChildren = !!node.children?.length;
    const isExpanded = expanded.has(node.value) || !!query;
    return (
      <li key={node.value} role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined} aria-selected={node.value === value}>
        <div className={cn(
          "flex min-h-8 items-center rounded-sm py-0.5 pr-1 hover:bg-accent hover:text-accent-foreground",
          node.value === value && "bg-accent text-accent-foreground",
          node.disabled && "pointer-events-none opacity-50",
        )} style={{ paddingInlineStart: 8 + depth * 16 }}>
          {hasChildren ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={isExpanded ? "Collapse" : "Expand"}
              onClick={() => toggleExpanded(node)}
            >
              {isExpanded ? <ChevronDownIcon /> : <RightOutlined />}
            </Button>
          ) : <span className="size-6 shrink-0" aria-hidden="true" />}
          <button type="button" className="min-w-0 flex-1 truncate py-1 text-left text-sm" disabled={node.disabled} onClick={() => select(node)}>
            {node.title}
          </button>
        </div>
        {hasChildren && isExpanded && <ul className="space-y-px pt-px" role="group">{renderNodes(node.children!, depth + 1)}</ul>}
      </li>
    );
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative w-full" style={style}>
        <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls="tree-select-options"
          aria-haspopup="tree"
          className={cn(
            "h-9 w-full min-w-0 justify-between border-input bg-transparent px-2.5 py-2 text-sm shadow-xs dark:bg-input/30 dark:hover:bg-input/50",
            allowClear && value != null ? "pr-1" : undefined,
            className,
          )}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); }
          }}
        >
          <span className={cn("min-w-0 flex-1 truncate text-left", !selected && "text-muted-foreground")}>
            {selected?.title ?? placeholder}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </Button>
        </PopoverTrigger>
        {allowClear && value != null && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear"
            className="absolute right-7 top-1/2 z-10 -translate-y-1/2"
            onClick={() => onChange?.(undefined)}
          >
            <CloseOutlined />
          </Button>
        )}
      </div>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-56 border-0 bg-popover p-0 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
        <div className="overflow-auto p-1" style={{ maxHeight: popupHeight }}>
          {searchable && (
            <Input
              autoFocus
              className="m-1.5 w-[calc(100%-0.75rem)] bg-transparent"
              value={query}
              placeholder={searchPlaceholder}
              onChange={(event) => { setQuery(event.target.value); onSearch?.(event.target.value); }}
            />
          )}
          {visibleNodes.length ? <ul id="tree-select-options" className="space-y-px p-1" role="tree">{renderNodes(visibleNodes)}</ul> : (emptyContent ?? <div className="p-5 text-center text-sm text-muted-foreground">No data</div>)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
