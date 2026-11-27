import { authFetch } from "@/lib/auth/client";
import { DIRECT_UPLOAD_THRESHOLD_BYTES, UPLOAD_KEY_HEADER, UPLOAD_TYPE_HEADER } from "./constants";
import type { PreparedUpload, UploadOptions, UploadTicket } from "./types";

/** A refused or failed storage upload; `status` is absent for network errors. */
export class StorageUploadError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
	}
}

function approximateSize(body: FormData | Blob): number {
	if (body instanceof Blob) return body.size;
	let total = 0;
	for (const [name, value] of body.entries()) {
		// The multipart boundary and part headers.
		total += 200 + name.length + (typeof value === "string" ? value.length * 3 : value.size);
	}
	return total;
}

/** True when this build must send the body through storage (set by next.config.ts, Vercel only). */
export function needsDirectUpload(body: FormData | Blob): boolean {
	return process.env.NEXT_PUBLIC_MAILFLARE_UPLOADS === "storage" && approximateSize(body) > DIRECT_UPLOAD_THRESHOLD_BYTES;
}

// XMLHttpRequest rather than fetch, because only it reports upload progress.
function putToStorage(url: string, headers: Record<string, string>, blob: Blob, options: UploadOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		const abort = () => request.abort();
		const done = (error?: Error) => {
			options.signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		request.open("PUT", url);
		for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
		request.upload.onprogress = (event) => { if (event.lengthComputable) options.onProgress?.(event.loaded, event.total); };
		request.onload = () => done(request.status >= 200 && request.status < 300 ? undefined : new StorageUploadError(`Upload to storage failed (${request.status})`, request.status));
		request.onerror = () => done(new StorageUploadError("Upload to storage failed: network error"));
		request.onabort = () => done(new StorageUploadError("Upload cancelled"));
		request.send(blob);
	});
}

/**
 * Returns the body unchanged when it can be posted as it is. Otherwise puts it in storage and returns the
 * headers the app needs to read it back; send the request with those and no body.
 */
export async function prepareUpload<Body extends FormData | Blob>(body: Body, options: UploadOptions = {}): Promise<PreparedUpload<Body>> {
	if (!needsDirectUpload(body)) return { body, headers: {} };
	// Serializing a form through Response gives the exact bytes and boundary the server will parse.
	const serialized = body instanceof Blob ? null : new Response(body);
	const type = serialized ? serialized.headers.get("content-type")! : "application/octet-stream";
	const blob = serialized ? await serialized.blob() : (body as Blob);
	const response = await authFetch("/api/uploads", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ size: blob.size }),
		signal: options.signal,
	});
	const ticket = (await response.json().catch(() => ({}))) as Partial<UploadTicket> & { error?: string };
	if (!response.ok || !ticket.url || !ticket.key) throw new StorageUploadError(ticket.error ?? `Upload failed (${response.status})`, response.status);
	await putToStorage(ticket.url, ticket.headers ?? {}, blob, options);
	return { body: undefined, headers: { [UPLOAD_KEY_HEADER]: ticket.key, [UPLOAD_TYPE_HEADER]: type } };
}
