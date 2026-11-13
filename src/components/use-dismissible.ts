"use client";

import { useEffect, useEffectEvent } from "react";
import type { RefObject } from "react";

export function useDismissible(open: boolean, onClose: () => void, container: RefObject<HTMLElement | null>) {
	const close = useEffectEvent(onClose);

	useEffect(() => {
		if (!open) return;

		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			close();
			container.current?.querySelector<HTMLElement>("[aria-expanded]")?.focus();
		}
		function onPointerDown(event: PointerEvent) {
			if (!container.current?.contains(event.target as Node)) close();
		}
		function onFocusIn(event: FocusEvent) {
			if (!container.current?.contains(event.target as Node)) close();
		}

		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("focusin", onFocusIn);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("focusin", onFocusIn);
		};
	}, [open, container]);
}
