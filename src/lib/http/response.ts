/**
 * Parse a response body as a JSON object, or `{}` when it is not JSON (for
 * example an HTML 502 page from a proxy). Callers then fall through to their
 * own `res.ok` handling and fallback message.
 */
export async function readResponseJson<T extends object>(res: Response): Promise<T> {
	try {
		const data: unknown = await res.json();
		return (data && typeof data === "object" ? data : {}) as T;
	} catch {
		return {} as T;
	}
}
