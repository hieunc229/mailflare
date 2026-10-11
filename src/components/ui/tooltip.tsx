"use client";

import { cn } from "@/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TooltipPosition, TooltipProps } from "./tooltip-types";
import { getTooltipPosition } from "./tooltip-utils";

/** Touch screens have no hover: a tooltip would pop up on tap and stay until something else is touched. */
function canHover(): boolean {
	return typeof window === "undefined" || window.matchMedia("(hover: hover)").matches;
}

export function Tooltip({ label, children, className, placement = "auto" }: TooltipProps) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<TooltipPosition | null>(null);
	const triggerRef = useRef<HTMLSpanElement>(null);
	const tooltipRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!open) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open]);

	useLayoutEffect(() => {
		if (!open) return;

		function updatePosition() {
			if (!triggerRef.current || !tooltipRef.current) return;
			setPosition(getTooltipPosition(triggerRef.current, tooltipRef.current, placement));
		}

		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);

		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [label, open, placement]);

	if (!label) return children

	return (
		<span
			ref={triggerRef}
			className={cn("inline-flex", className)}
			onFocusCapture={() => { if (canHover()) setOpen(true); }}
			onBlurCapture={() => setOpen(false)}
			onMouseEnter={() => { if (canHover()) setOpen(true); }}
			onMouseLeave={() => setOpen(false)}
			onClickCapture={() => setOpen(false)}
		>
			{children}
			{open && typeof document !== "undefined" &&
				createPortal(
					<span
						ref={tooltipRef}
						role="tooltip"
						className="pointer-events-none fixed z-[100] max-w-[min(20rem,calc(100vw-1rem))] rounded-md bg-neutral-900 px-2 py-1 text-center text-xs font-medium text-white shadow-lg"
						style={{
							left: position?.left ?? 0,
							top: position?.top ?? 0,
							visibility: position ? "visible" : "hidden",
						}}
					>
						{label}
					</span>,
					document.body,
				)}
		</span>
	);
}
