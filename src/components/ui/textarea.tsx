import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
	({ className, ...props }, ref) => (
		<textarea
			className={cn(
				"flex min-h-[80px] w-full rounded-md border border-neutral-200 bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			ref={ref}
			{...props}
		/>
	),
);
Textarea.displayName = "Textarea";
