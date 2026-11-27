import { authFetch, getAuthHeaders } from "@/lib/auth/client";
import { parseRetryAfter, sleepFor } from "@/lib/import/takeout-calendar-utils";
import { needsDirectUpload, prepareUpload } from "@/lib/uploads/client";

/** Tries for one request (starting, one part, completing). */
const TRIES = 5;
const BACKOFF_MS = 1000;

/** A refused upload; `status` lets callers tell "storage is full" (413) from other failures. */
export class DriveUploadError extends Error {
	status: number;
	/** The server's Retry-After, in milliseconds. */
	retryAfterMs?: number;
	constructor(message: string, status: number, retryAfterMs?: number) {
		super(message);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

async function readError(response: Response): Promise<Error> {
	const data = await response.json().catch(() => null) as { error?: string } | null;
	return new DriveUploadError(data?.error ?? `Upload failed (${response.status})`, response.status);
}

/** An answer worth asking again for: the server is busy or failing. Anything else (a 4xx) would come back the same. */
const transient = (status: number) => status >= 500 || status === 429;

export type DriveUploadOptions = { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> };

/** Sends a request again after a 5xx, a 429 or a network error, up to 5 tries: after the server's Retry-After, else 1, 2, 4 and 8 seconds. */
async function sendWithRetry(send: () => Promise<Response>, sleep: NonNullable<DriveUploadOptions["sleep"]>, signal?: AbortSignal): Promise<Response> {
	for (let attempt = 1; ; attempt += 1) {
		let wait = BACKOFF_MS * 2 ** (attempt - 1);
		try {
			const response = await send();
			if (!transient(response.status) || attempt >= TRIES) return response;
			wait = parseRetryAfter(response.headers.get("Retry-After")) ?? wait;
		} catch (error) {
			if (attempt >= TRIES || signal?.aborted) throw error;
		}
		await sleep(wait, signal);
		if (signal?.aborted) throw new Error("Upload cancelled");
	}
}

// XMLHttpRequest rather than fetch, because only it reports upload progress. Browsers that do not
// compute the length still finish the part; progress then moves once per part.
async function putPart(url: string, chunk: Blob, onBytes: (loaded: number) => void, signal?: AbortSignal): Promise<void> {
	if (!needsDirectUpload(chunk)) return sendPart(url, chunk, {}, onBytes, signal);
	const upload = await prepareUpload(chunk, { onProgress: onBytes, signal });
	return sendPart(url, upload.body, upload.headers, () => {}, signal);
}

function sendPart(url: string, chunk: Blob | undefined, extraHeaders: Record<string, string>, onBytes: (loaded: number) => void, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		const abort = () => request.abort();
		signal?.addEventListener("abort", abort, { once: true });
		request.open("PUT", url);
		getAuthHeaders(chunk ? { "Content-Type": "application/octet-stream" } : extraHeaders).forEach((value, name) => request.setRequestHeader(name, value));
		request.upload.onprogress = (event) => { if (event.lengthComputable) onBytes(event.loaded); };
		request.onload = () => {
			signal?.removeEventListener("abort", abort);
			if (request.status >= 200 && request.status < 300) { resolve(); return; }
			let message: string | undefined;
			try { message = (JSON.parse(request.responseText) as { error?: string }).error; } catch { /* not JSON */ }
			reject(new DriveUploadError(message ?? `Upload failed (${request.status})`, request.status, parseRetryAfter(request.getResponseHeader("Retry-After"))));
		};
		request.onerror = () => { signal?.removeEventListener("abort", abort); reject(new Error("Upload failed: network error")); };
		request.onabort = () => { signal?.removeEventListener("abort", abort); reject(new Error("Upload cancelled")); };
		request.send(chunk ?? null);
	});
}

/** Where an upload's bytes come from: a picked File, or an entry read out of a zip. Parts are asked for in increasing order. */
export type DriveUploadSource = {
	name: string;
	size: number;
	type: string;
	/** Same name, size and fingerprint in the same folder continues an interrupted upload. */
	fingerprint: string;
	readPart(index: number, partSize: number): Promise<Blob>;
	/** Called after the last part and before the upload is completed; a throw discards the upload on the server. */
	verify?(): Promise<void>;
};

/**
 * Uploads a source in parts, each sent as a raw request body. Not multipart/form-data: the runtime treats every
 * multipart POST as a server action and rejects anything over 1 MB.
 *
 * The server remembers which parts arrived. Interrupted uploads (lost connection, closed tab) are not discarded:
 * picking the same file again, same name, size and fingerprint, into the same folder continues after the last stored part.
 */
export async function uploadDriveSource(source: DriveUploadSource, parentId: string | null, onProgress: (percent: number, resumed: boolean) => void, signal?: AbortSignal, options: DriveUploadOptions = {}): Promise<void> {
	const sleep = options.sleep ?? sleepFor;
	const cancelled = () => new Error("Upload cancelled");
	if (signal?.aborted) throw cancelled();
	const startBody = JSON.stringify({ name: source.name, size: source.size, contentType: source.type || "application/octet-stream", parentId, fingerprint: source.fingerprint });
	const start = await sendWithRetry(() => authFetch("/api/drive/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: startBody, signal }), sleep, signal);
	if (!start.ok) throw await readError(start);
	const session = await start.json() as { id?: string; partSize?: number; parts?: number; uploaded?: number[]; resumed?: boolean; complete?: boolean };
	if (session.complete) return;
	const { id, partSize, parts } = session as { id: string; partSize: number; parts: number };
	const stored = new Set(session.uploaded ?? []);
	const resumed = !!session.resumed;
	const partBytes = (index: number) => Math.max(0, Math.min(partSize, source.size - index * partSize));
	let sent = [...stored].reduce((total, part) => total + partBytes(part - 1), 0);
	// Held at 99% until the server has assembled the parts.
	const report = (bytes: number) => onProgress(source.size ? Math.min(99, Math.floor((bytes / source.size) * 100)) : 99, resumed);
	report(sent);
	for (let index = 0; index < parts; index += 1) {
		if (stored.has(index + 1)) continue;
		if (signal?.aborted) throw cancelled();
		const chunk = await source.readPart(index, partSize);
		for (let attempt = 1; ; attempt += 1) {
			try {
				await putPart(`/api/drive/upload/${id}?part=${index + 1}`, chunk, (loaded) => report(sent + loaded), signal);
				break;
			} catch (error) {
				const status = (error as Partial<DriveUploadError>).status;
				if (attempt >= TRIES || signal?.aborted || (status !== undefined && !transient(status))) throw error;
				await sleep((error as Partial<DriveUploadError>).retryAfterMs ?? BACKOFF_MS * 2 ** (attempt - 1), signal);
			}
		}
		sent += chunk.size;
		report(sent);
	}
	if (source.verify) {
		try { await source.verify(); }
		catch (error) {
			await authFetch(`/api/drive/upload/${id}`, { method: "DELETE" }).catch(() => undefined);
			throw error;
		}
	}
	const finish = await sendWithRetry(() => authFetch(`/api/drive/upload/${id}`, { method: "POST", signal }), sleep, signal);
	if (!finish.ok) throw await readError(finish);
}

/** Uploads a picked file; its modified time identifies it when the upload has to be resumed. */
export function uploadDriveFile(file: File, parentId: string | null, onProgress: (percent: number, resumed: boolean) => void): Promise<void> {
	return uploadDriveSource({ name: file.name, size: file.size, type: file.type, fingerprint: String(file.lastModified), readPart: async (index, partSize) => file.slice(index * partSize, (index + 1) * partSize) }, parentId, onProgress);
}
