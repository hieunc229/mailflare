import { RequestBodyTooLargeError } from "./errors";

export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > maxBytes) throw new RequestBodyTooLargeError("Request body is too large");

	const body = await request.arrayBuffer();
	if (body.byteLength > maxBytes) throw new RequestBodyTooLargeError("Request body is too large");
	if (body.byteLength === 0) return {} as T;

	return JSON.parse(new TextDecoder().decode(body)) as T;
}

export function assertRequestSize(request: Request, maxBytes: number): void {
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > maxBytes) throw new RequestBodyTooLargeError("Request body is too large");
}

export async function readFormDataBody(request: Request, maxBytes: number): Promise<FormData> {
	assertRequestSize(request, maxBytes);
	const body = await request.arrayBuffer();
	if (body.byteLength > maxBytes) throw new RequestBodyTooLargeError("Request body is too large");

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
