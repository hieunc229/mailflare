"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { CustomDateTimeInput } from "./custom-date-time-input";
import { CustomFileInput } from "./custom-file-input";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
	({ className, type, onKeyDown, onPaste, onChange, ...props }, ref) => {
		const lastNumber = React.useRef(String(props.value ?? props.defaultValue ?? ""));
		if (props.value !== undefined) lastNumber.current = String(props.value ?? "");
		const handlers = {
			onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => { onKeyDown?.(event); if (type === "number" && !event.ctrlKey && !event.metaKey && ["-", "+", "e", "E", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault(); },
			onPaste: (event: React.ClipboardEvent<HTMLInputElement>) => { onPaste?.(event); if (type === "number" && !/^\d+(?:\.\d*)?$/.test(event.clipboardData.getData("text").trim())) event.preventDefault(); },
			onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
				if (type === "number") {
					const next = event.currentTarget.value;
					if (next && (!Number.isFinite(Number(next)) || Number(next) < 0)) { event.currentTarget.value = lastNumber.current; return; }
					lastNumber.current = next;
				}
				onChange?.(event);
			},
		};
		if (type === "date" || type === "time" || type === "datetime-local") {
			return <CustomDateTimeInput {...props} {...handlers} type={type as "date" | "time" | "datetime-local"} className={className} ref={ref} />;
		}
		if (type === "file" && !props.hidden && !/(?:^|\s)(?:hidden|sr-only)(?:\s|$)/.test(className ?? "")) return <CustomFileInput {...props} {...handlers} className={className} ref={ref} />;
		return <input type={type} inputMode={type === "number" ? "decimal" : undefined} className={cn("flex h-10 w-full rounded-md border border-neutral-200 bg-transparent px-3 py-2 text-sm shadow-sm shadow-neutral-200/50 placeholder:text-neutral-500 focus-visible:outline-none focus-visible:border-blue-600 disabled:cursor-not-allowed disabled:opacity-50", className)} ref={ref} {...props} {...handlers} />;
	},
);
Input.displayName = "Input";
