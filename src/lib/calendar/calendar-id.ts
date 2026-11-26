/** Calendar ids contain a colon (`cal:...`), which clients may send percent-encoded. */
export function calendarIdFrom(raw: string): string {
	try { return decodeURIComponent(raw); } catch { return raw; }
}
