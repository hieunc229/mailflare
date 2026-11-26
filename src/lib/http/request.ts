import { RequestBodyTooLargeError } from "./errors";

/**
 * Reads a request body without ever buffering more than maxBytes. A declared Content-Length over the
 * cap is refused up front; chunked or understated bodies are cut off as soon as the cap is crossed.
 */
export async function readRawBody(request: Pick<Request, "headers" | "body">, maxBytes: number): Promise<ArrayBuffer> {
	assertRequestSize(request, maxBytes);
	const reader = request.body?.getReader();
	if (!reader) return new ArrayBuffer(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new RequestBodyTooLargeError("Request body is too large");
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body.buffer;
}

export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
	const body = await readRawBody(request, maxBytes);
	if (body.byteLength === 0) return {} as T;

	return JSON.parse(new TextDecoder().decode(body)) as T;
}

export function assertRequestSize(request: Pick<Request, "headers">, maxBytes: number): void {
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > maxBytes) throw new RequestBodyTooLargeError("Request body is too large");
}

export async function readFormDataBody(request: Request, maxBytes: number): Promise<FormData> {
	const body = await readRawBody(request, maxBytes);

	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body,
	}).formData();
}

/** Parses a JSON object body. `null` when the body is empty, malformed or not an object, so handlers can answer 400. */
export async function readJsonObject<T = Record<string, unknown>>(request: Request): Promise<T | null> {
	const body: unknown = await request.json().catch(() => null);
	return body && typeof body === "object" && !Array.isArray(body) ? (body as T) : null;
}
