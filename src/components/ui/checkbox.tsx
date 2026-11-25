import * as React from "react";
import { cn } from "@/lib/utils";
import type { CheckboxProps } from "./checkbox-types";

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
	({ className, ...props }, ref) => (
		<input
			type="checkbox"
			className={cn(
				"h-4 w-4 pointer-coarse:h-6 pointer-coarse:w-6 shrink-0 rounded border-neutral-300 text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			ref={ref}
			{...props}
		/>
	),
);
Checkbox.displayName = "Checkbox";
