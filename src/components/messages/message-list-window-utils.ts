/** Rough height of a split-view row, used until a page has been measured. */
export const ESTIMATED_ROW_HEIGHT = 86;
/** Pages kept loaded on each side of the ones near the viewport. */
const OVERSCAN_PAGES = 2;

export function getPageHeights(heights: Record<number, number>, pageSize: number, total: number): number[] {
	const count = Math.max(1, Math.ceil(total / pageSize));
	const firstRows = Math.min(pageSize, total);
	const rowHeight = heights[0] && firstRows ? heights[0] / firstRows : ESTIMATED_ROW_HEIGHT;
	return Array.from({ length: count }, (_, index) => (
		heights[index] ?? Math.max(0, Math.min(pageSize, total - index * pageSize)) * rowHeight
	));
}

/**
 * The pages to keep mounted: those overlapping the viewport, a few either side,
 * and any pinned ones. Derived from the scroll position alone, so a page in view
 * is rendered without waiting for an observer to report it.
 */
export function getActivePages(pageHeights: number[], top: number, viewportHeight: number, pinned: Set<number>): number[] {
	const last = pageHeights.length - 1;
	let first = -1;
	let end = -1;
	let start = 0;
	for (let index = 0; index <= last; index++) {
		const bottom = start + pageHeights[index];
		if (first === -1 && bottom >= top) first = index;
		if (start <= top + viewportHeight) end = index;
		start = bottom;
	}
	// Scrolled past the end, e.g. just after the list shrank.
	if (first === -1) first = last;
	const from = Math.max(0, first - OVERSCAN_PAGES);
	const to = Math.min(last, Math.max(first, end) + OVERSCAN_PAGES);
	const active = new Set(pinned);
	for (let index = from; index <= to; index++) active.add(index);
	return Array.from(active).filter((index) => index <= last).sort((a, b) => a - b);
}
