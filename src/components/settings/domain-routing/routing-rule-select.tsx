import * as React from "react";
import { ChevronDown } from "@/components/icons";
import type { SelectProps } from "@/components/ui/select-types";
import { cn } from "@/lib/utils";

export const RoutingRuleSelect = React.forwardRef<HTMLSelectElement, SelectProps>(
	({ className, ...props }, ref) => (
		<span className="relative block min-w-0">
			<select
				ref={ref}
				className={cn(
					"flex h-10 w-full appearance-none truncate rounded-md border border-neutral-200 bg-transparent py-2 pl-3 pr-9 text-sm shadow-sm shadow-neutral-200/50 focus-visible:border-blue-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
				{...props}
			/>
			<ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
		</span>
	),
);
RoutingRuleSelect.displayName = "RoutingRuleSelect";
