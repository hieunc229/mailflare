/** Helpers for usePhoneScrollLock: which element a drag would scroll, and whether it still can. */

/** The nearest ancestor that scrolls along `axis`, outside the app behind the sheet. */
export function findScroller(start: Element | null, axis: "x" | "y"): HTMLElement | null {
	for (let element = start; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
		if (element.classList.contains("mf-app-root")) return null;
		if (!(element instanceof HTMLElement)) continue;
		const style = getComputedStyle(element);
		const overflow = axis === "y" ? style.overflowY : style.overflowX;
		if (overflow !== "auto" && overflow !== "scroll") continue;
		const room = axis === "y" ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
		if (room > 1) return element;
	}
	return null;
}

/** Whether a finger moving by (dx, dy) would scroll `element` rather than hit its end. */
export function canScrollFurther(element: HTMLElement, dx: number, dy: number) {
	if (Math.abs(dx) > Math.abs(dy)) {
		const max = element.scrollWidth - element.clientWidth;
		return dx < 0 ? element.scrollLeft < max - 1 : element.scrollLeft > 1;
	}
	const max = element.scrollHeight - element.clientHeight;
	// A finger moving up scrolls content down.
	return dy < 0 ? element.scrollTop < max - 1 : element.scrollTop > 1;
}
