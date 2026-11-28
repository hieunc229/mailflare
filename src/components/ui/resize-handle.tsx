"use client";

import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { ResizeHandleProps } from "./resize-handle-types";

export function ResizeHandle({ label, onResizeStart, onResize, onResizeEnd }: ResizeHandleProps) {
	const startX = useRef<number | null>(null);

	function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		startX.current = event.clientX;
		event.currentTarget.setPointerCapture(event.pointerId);
		onResizeStart?.();
		event.preventDefault();
	}

	function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
		if (startX.current === null) return;
		onResize(event.clientX - startX.current);
	}

	function handlePointerEnd() {
		if (startX.current === null) return;
		startX.current = null;
		onResizeEnd?.();
	}

	// Same start/resize/end contract as the pointer path, so consumers persist the width.
	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const step = event.shiftKey ? 64 : 16;
		onResizeStart?.();
		onResize(event.key === "ArrowRight" ? step : -step);
		onResizeEnd?.();
	}

	return (
		<div
			role="separator"
			tabIndex={0}
			onKeyDown={handleKeyDown}
			aria-label={label}
			aria-orientation="vertical"
			className="absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize touch-none"
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerEnd}
			onPointerCancel={handlePointerEnd}
		/>
	);
}
