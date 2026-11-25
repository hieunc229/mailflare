"use client";

import { cn } from "@/lib/utils";
import type { SwitchProps } from "./switch-types";

export function Switch({
	checked,
	onCheckedChange,
	className,
	disabled,
	...props
}: SwitchProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={cn(
				"relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
				checked ? "bg-blue-600" : "bg-neutral-300",
				className,
			)}
			{...props}
		>
			<span
				className={cn(
					"pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
					checked ? "translate-x-[21px] rtl:-translate-x-[21px]" : "translate-x-0.5 rtl:-translate-x-0.5",
				)}
			/>
		</button>
	);
}
