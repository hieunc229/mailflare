import * as React from "react";
import { Select } from "@/components/ui/select";
import type { SelectProps } from "@/components/ui/select-types";
import { cn } from "@/lib/utils";

export const RoutingRuleSelect = React.forwardRef<HTMLButtonElement, SelectProps>(
	({ className, containerClassName, ...props }, ref) => (
		<Select
			ref={ref}
			containerClassName={cn("block min-w-0 rounded-none border-0 px-0", containerClassName)}
			className={cn(
				"h-10 rounded-md border border-neutral-200 py-2 pl-3 pr-3 text-sm shadow-sm shadow-neutral-200/50 focus-visible:border-blue-600",
				className,
			)}
			{...props}
		/>
	),
);
RoutingRuleSelect.displayName = "RoutingRuleSelect";
