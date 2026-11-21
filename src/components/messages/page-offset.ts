/**
 * The page to show after the visible page empties. A page that is still within
 * the new total is waiting for its backfill, so leave the offset alone; only an
 * out-of-range page (or an empty folder) moves back.
 */
export function getEmptyPageOffset(offset: number, total: number, limit: number): number | null {
	if (offset === 0 || offset < total) return null;
	return total > 0 ? Math.floor((total - 1) / limit) * limit : 0;
}
