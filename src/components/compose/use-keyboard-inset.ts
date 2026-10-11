"use client";

import { useEffect, useLayoutEffect } from "react";
import { canScrollFurther, findScroller } from "./scroll-lock-utils";

/**
 * Stops the page moving under a phone sheet, the way a native sheet holds still.
 *
 * With the keyboard up, iOS lets a drag pan the whole page over the keyboard: the sheet's header
 * slides under the status bar, black shows below it, and the inbox behind scrolls. A non-passive
 * touchmove listener cancels every drag except one that scrolls an inner scroller (the message
 * body, the formatting row, a menu) that still has room to move in that direction.
 */
export function usePhoneScrollLock(enabled: boolean) {
	useEffect(() => {
		if (!enabled || !window.matchMedia("(pointer: coarse)").matches) return;
		let startX = 0;
		let startY = 0;
		const onStart = (event: TouchEvent) => {
			startX = event.touches[0]?.clientX ?? 0;
			startY = event.touches[0]?.clientY ?? 0;
		};
		const onMove = (event: TouchEvent) => {
			if (event.touches.length > 1) return; // pinch zoom stays available
			const touch = event.touches[0];
			const dx = touch.clientX - startX;
			const dy = touch.clientY - startY;
			const scroller = findScroller(event.target as Element | null, Math.abs(dx) > Math.abs(dy) ? "x" : "y");
			if (scroller && canScrollFurther(scroller, dx, dy)) return;
			if (event.cancelable) event.preventDefault();
		};
		document.addEventListener("touchstart", onStart, { passive: true });
		document.addEventListener("touchmove", onMove, { passive: false });
		return () => {
			document.removeEventListener("touchstart", onStart);
			document.removeEventListener("touchmove", onMove);
		};
	}, [enabled]);
}

const PHONE_QUERY = "(max-width: 767px)";

/** Gap above a phone sheet where the page behind, shrunk back like an iOS card, peeks out. */
export const PHONE_SHEET_GAP = 20;

/**
 * Keeps a phone sheet glued to the part of the screen that is actually visible.
 *
 * When the keyboard opens and on every caret move, Safari pans the visible area over the page.
 * Fixed elements move with that pan, so a sheet positioned once would slide off the top until
 * something caught up. This writes top/height straight to the element on every frame while the
 * viewport is moving (no React render in between), so the sheet holds still on screen. `cover`
 * hides the gap above the sheet while panned, where a slice of the page would show through.
 */
export function usePhoneSheetPosition(
	sheet: React.RefObject<HTMLElement | null>,
	cover: React.RefObject<HTMLElement | null> | null,
	enabled: boolean,
) {
	useLayoutEffect(() => {
		const viewport = window.visualViewport;
		const query = window.matchMedia(PHONE_QUERY);
		if (!enabled || !viewport) return;
		let frame = 0;
		let until = 0;
		// ?vvdebug shows the numbers Safari reports, for checking this on a real device or simulator.
		let debug: HTMLDivElement | null = null;
		if (new URLSearchParams(window.location.search).has("vvdebug")) {
			debug = document.createElement("div");
			debug.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:9999;background:#000c;color:#0f0;font:11px/1.3 monospace;padding:2px 4px;pointer-events:none;";
			document.body.appendChild(debug);
		}
		const apply = () => {
			const element = sheet.current;
			if (!element) return;
			if (!query.matches) {
				element.style.setProperty("top", "");
				element.style.setProperty("height", "");
				if (cover?.current) cover.current.style.setProperty("display", "none");
				return;
			}
			const top = viewport.offsetTop;
			// The page behind (the shrunken card) moves with Safari's pan too; shift it back the same amount.
			document.documentElement.style.setProperty("--mf-vv-top", `${top}px`);
			element.style.setProperty("top", `${top + PHONE_SHEET_GAP}px`);
			element.style.setProperty("height", `${viewport.height - PHONE_SHEET_GAP}px`);
			if (debug) {
				const rect = element.getBoundingClientRect();
				debug.style.setProperty("top", `${top + viewport.height - 30}px`);
				debug.textContent = `vv top ${Math.round(top)} h ${Math.round(viewport.height)} · scrollY ${Math.round(window.scrollY)} · inner ${window.innerHeight} · sheet ${Math.round(rect.top)}–${Math.round(rect.bottom)} · ${document.activeElement?.id || document.activeElement?.tagName}`;
			}
			if (cover?.current) {
				cover.current.style.setProperty("display", top > 2 ? "block" : "none");
				cover.current.style.setProperty("top", `${top}px`);
				cover.current.style.setProperty("height", `${PHONE_SHEET_GAP + 2}px`);
			}
		};
		const tick = () => {
			apply();
			if (performance.now() < until) frame = requestAnimationFrame(tick);
		};
		// Safari reports the pan late and in steps; follow it frame by frame for a moment.
		const follow = () => {
			until = performance.now() + 1000;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(tick);
		};
		apply();
		viewport.addEventListener("resize", follow);
		viewport.addEventListener("scroll", follow);
		document.addEventListener("focusin", follow);
		document.addEventListener("focusout", follow);
		document.addEventListener("selectionchange", follow);
		query.addEventListener("change", apply);
		return () => {
			cancelAnimationFrame(frame);
			debug?.remove();
			document.documentElement.style.removeProperty("--mf-vv-top");
			viewport.removeEventListener("resize", follow);
			viewport.removeEventListener("scroll", follow);
			document.removeEventListener("focusin", follow);
			document.removeEventListener("focusout", follow);
			document.removeEventListener("selectionchange", follow);
			query.removeEventListener("change", apply);
		};
	}, [sheet, cover, enabled]);
}
