import * as React from "react";
import { cn } from "@/lib/utils";
import type { SelectProps } from "./select-types";
import { CustomSelect } from "./custom-select";

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, containerClassName, ...props }, ref) => (
    <span className={cn("inline-flex min-w-0", containerClassName)}>
      <CustomSelect
        className={cn("flex h-10 w-full rounded-md bg-transparent px-3 py-2 text-sm focus-visible:border-blue-600 disabled:cursor-not-allowed disabled:opacity-50", /(?:^|\s)border-0(?:\s|$)/.test(containerClassName ?? "") && "rounded-none border-0", className)}
        ref={ref}
        {...props}
      />
    </span>
  ),
);
Select.displayName = "Select";
