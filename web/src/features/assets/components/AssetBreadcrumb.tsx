import * as React from "react";

import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AssetFolder } from "@/features/assets/types";

interface AssetBreadcrumbProps {
  rootLabel: string;
  folders: AssetFolder[];
  activeFolderId: string | null;
  onNavigate: (folderId: string | null) => void;
  getFolderLabel?: (folder: AssetFolder) => string;
  collapsedLabel: string;
  className?: string;
  itemClassName?: string;
}

export default function AssetBreadcrumb({
  rootLabel,
  folders,
  activeFolderId,
  onNavigate,
  getFolderLabel = (folder) => folder.name,
  collapsedLabel,
  className,
  itemClassName,
}: AssetBreadcrumbProps) {
  const hasCollapsedFolders = folders.length > 2;
  const visibleFolders = hasCollapsedFolders ? [folders[0], folders[folders.length - 1]] : folders;
  const collapsedFolders = hasCollapsedFolders ? folders.slice(1, -1) : [];

  return (
    <Breadcrumb className={className}>
      <BreadcrumbList>
        <BreadcrumbItem>
          {activeFolderId === null ? (
            <BreadcrumbPage className={itemClassName}>{rootLabel}</BreadcrumbPage>
          ) : (
            <BreadcrumbLink asChild className={itemClassName}>
              <button type="button" onClick={() => onNavigate(null)}>
                {rootLabel}
              </button>
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        {hasCollapsedFolders && (
          <React.Fragment key="collapsed-folders">
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={collapsedLabel}>
                    <BreadcrumbEllipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuGroup>
                    {collapsedFolders.map((folder) => (
                      <DropdownMenuItem key={folder.id} onSelect={() => onNavigate(folder.id)}>
                        {getFolderLabel(folder)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
          </React.Fragment>
        )}
        {visibleFolders.map((folder) => {
          const isCurrent = folder.id === activeFolderId;
          const label = getFolderLabel(folder);
          return (
            <React.Fragment key={folder.id}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {isCurrent ? (
                  <BreadcrumbPage className={itemClassName}>{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild className={itemClassName}>
                    <button type="button" onClick={() => onNavigate(folder.id)}>
                      {label}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
