/** Largest body for PROPFIND, PROPPATCH and REPORT. */
export const MAX_XML_BODY = 256 * 1024;

/**
 * Read a request body as text, stopping at `max` bytes. The Content-Length
 * header is only a hint, so the stream itself is counted. Returns null when
 * the body is too large.
 */
export async function readBodyText(request: Request, max: number): Promise<string | null> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (Number.isFinite(declared) && declared > max) return null;
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
