"use client";

import { useEffect, useState } from "react";
import type { RefObject } from "react";

const FOCUSABLE = ["a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])", "textarea:not([disabled])", "[tabindex]"]
	.map((selector) => `${selector}:not([tabindex="-1"])`)
	.join(", ");

export function getFocusable(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null || element === document.activeElement);
}

function ownsPortaledFocus(root: HTMLElement, active: Element): boolean {
	const scopes = [root];
	const seen = new Set<Element>(scopes);
	for (const scope of scopes) {
		for (const controller of scope.querySelectorAll<HTMLElement>("[aria-controls]")) {
			for (const id of controller.getAttribute("aria-controls")!.split(/\s+/)) {
				const controlled = document.getElementById(id);
				if (!controlled || seen.has(controlled) || !controlled.matches('[role="dialog"], [role="listbox"], [role="menu"], [data-ui-popup]')) continue;
				if (controlled.contains(active)) return true;
				seen.add(controlled);
				scopes.push(controlled);
			}
		}
	}
	return false;
}

export function useDialogFocus(container: RefObject<HTMLElement | null>, initialFocus?: RefObject<HTMLElement | null>) {
	const [opener] = useState(() => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));

	useEffect(() => {
		const root = container.current;
		(initialFocus?.current ?? (root ? getFocusable(root)[0] : null) ?? root)?.focus();

		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Tab" || !root) return;
			const topmostDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
			if (topmostDialog && topmostDialog !== root && !topmostDialog.contains(root) && topmostDialog.contains(document.activeElement)) return;
			if (document.activeElement && !root.contains(document.activeElement) && ownsPortaledFocus(root, document.activeElement)) return;
			const focusable = getFocusable(root);
			if (focusable.length === 0) {
				event.preventDefault();
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const inside = root.contains(document.activeElement);
			if (event.shiftKey && (!inside || document.activeElement === first)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (!inside || document.activeElement === last)) {
				event.preventDefault();
				first.focus();
			}
		}

		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [container, initialFocus]);

	useEffect(() => () => {
		if (opener?.isConnected) opener.focus();
	}, [opener]);
}
