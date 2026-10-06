"use client";

import type { ComponentProps } from "react";

import { ChevronDownIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { ModelIcon } from "../ModelIcon";

export interface ModelOption {
  value: string;
  name: string;
  providerName?: string;
}

type ModelSelectorProps = {
  models: readonly ModelOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  ariaLabel?: string;
  side?: ComponentProps<typeof DropdownMenuContent>["side"];
  align?: ComponentProps<typeof DropdownMenuContent>["align"];
  className?: string;
  disabled?: boolean;
};

export function ModelSelector({
  models,
  value,
  onValueChange,
  placeholder,
  ariaLabel,
  side = "bottom",
  align = "start",
  className,
  disabled = false,
}: ModelSelectorProps) {
  const selectedModel = models.find((model) => model.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn("max-w-[180px] justify-between gap-1 text-foreground", className)}
          aria-label={ariaLabel}
          disabled={disabled}
        >
          {selectedModel ? (
            <ModelIcon model={selectedModel.name} className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">
            {selectedModel?.name ?? placeholder}
          </span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align}>
        {models.map((model) => (
          <DropdownMenuItem
            key={model.value}
            className={model.value === value ? "bg-accent text-accent-foreground" : undefined}
            onSelect={() => onValueChange(model.value)}
          >
            <ModelIcon model={model.name} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{model.name}</span>
            {model.providerName ? (
              <span className="ml-auto max-w-24 truncate text-xs text-muted-foreground">
                {model.providerName}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
