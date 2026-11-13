"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { KeyboardEvent, PointerEvent } from "react";
import { useLanguage } from "@/components/language-provider";

export type DriveColumn = "owner" | "updatedAt" | "size";

const STORAGE_KEY = "mailflare-drive-columns";
const DEFAULT_WIDTHS: Record<DriveColumn, number> = { owner: 100, updatedAt: 144, size: 96 };
const MIN_WIDTH = 72;
const MAX_WIDTH = 480;
const clamp = (value: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));

/** Widths of the resizable columns; the name column takes whatever is left. Remembered per browser. */
export function useDriveColumns() {
	const [widths, setWidths] = useState(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Record<DriveColumn, number>> | null;
			if (saved) return { owner: clamp(saved.owner ?? DEFAULT_WIDTHS.owner), updatedAt: clamp(saved.updatedAt ?? DEFAULT_WIDTHS.updatedAt), size: clamp(saved.size ?? DEFAULT_WIDTHS.size) };
		} catch { /* storage unavailable: keep defaults */ }
		return DEFAULT_WIDTHS;
	});

	const resize = useCallback((column: DriveColumn, width: number, persist = false) => {
		setWidths((current) => {
			const next = { ...current, [column]: clamp(width) };
			if (persist) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ } }
			return next;
		});
	}, []);

	const template = `2rem minmax(0,1fr) ${widths.owner}px ${widths.updatedAt}px ${widths.size}px 2.5rem`;
	return { widths, resize, template };
}

/**
 * Drag handle on the left edge of a column header: dragging left makes the column wider. The drag is tracked on
 * `window` from the width it started with, so it ends cleanly wherever the pointer is released and never leaves a
 * listener behind on the handle.
 */
export function ColumnResizeHandle({ column, width, onResize, label }: { column: DriveColumn; width: number; onResize: (column: DriveColumn, width: number, persist?: boolean) => void; label: string }) {
	const { t } = useLanguage();
	const [dragging, setDragging] = useState(false);
	const cleanup = useRef<(() => void) | null>(null);
	useEffect(() => () => cleanup.current?.(), []);

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		event.preventDefault();
		cleanup.current?.();
		const startX = event.clientX;
		const startWidth = width;
		let latest = startWidth;
		const move = (moveEvent: globalThis.PointerEvent) => { latest = startWidth + (startX - moveEvent.clientX); onResize(column, latest); };
		const end = (endEvent?: globalThis.PointerEvent) => {
			if (endEvent && endEvent.type === "pointerup") latest = startWidth + (startX - endEvent.clientX);
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			window.removeEventListener("blur", cancel);
			document.body.style.removeProperty("cursor");
			document.body.style.removeProperty("user-select");
			cleanup.current = null;
			setDragging(false);
			onResize(column, latest, true);
		};
		const cancel = () => end();
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
		window.addEventListener("blur", cancel);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		cleanup.current = cancel;
		setDragging(true);
	}
	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const step = event.shiftKey ? 40 : 10;
		if (event.key === "ArrowLeft") { event.preventDefault(); onResize(column, width + step, true); }
		if (event.key === "ArrowRight") { event.preventDefault(); onResize(column, width - step, true); }
	}
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={t("drive.resizeColumn", { name: label })}
			aria-valuenow={width}
			aria-valuemin={MIN_WIDTH}
			aria-valuemax={MAX_WIDTH}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			className="group/handle absolute -left-2 top-0 flex h-full w-4 cursor-col-resize touch-none items-center justify-center outline-none"
		>
			<span className={clsx("h-5 w-0.5 rounded-full transition-colors", dragging ? "bg-blue-500" : "bg-transparent group-hover/handle:bg-blue-500 group-focus-visible/handle:bg-blue-500")} />
		</div>
	);
}
