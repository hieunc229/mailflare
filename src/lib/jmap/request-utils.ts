/** `decodeURIComponent` that reports a malformed escape (a bare `%`) as null instead of throwing. */
export function tryDecodeURIComponent(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

/** EventSource poll interval in seconds: default 30, minimum 10, and never NaN or infinite. */
export function parsePingSeconds(raw: string | null): number {
	const value = Number(raw || 30);
	return Number.isFinite(value) ? Math.max(value, 10) : 30;
}
