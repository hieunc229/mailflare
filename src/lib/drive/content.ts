import { getInlineContentType } from "@/lib/http/content-type";
import { driveContentDisposition, driveObjectKey } from "./utils";
import type { DriveRow } from "./types";

/** Parses a single `bytes=` range. Returns null when absent or unusable (multi-range is served whole), "invalid" when unsatisfiable. */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
	if (!match || (match[1] === "" && match[2] === "")) return null;
	let start: number;
	let end: number;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		if (suffix === 0) return "invalid";
		start = Math.max(size - suffix, 0);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	}
	return start >= size || start > end ? "invalid" : { start, end };
}

/** Streams a stored file with support for resumable downloads and seeking (`Range` / `If-Range`). */
export async function streamDriveFile(env: CloudflareEnv, request: Request, item: DriveRow, download: boolean): Promise<Response> {
	if (item.kind !== "file") return new Response("Not a file", { status: 400 });
	// The uploader chooses the type, so HTML, SVG and anything unparsable download as opaque bytes.
	const inlineType = download ? null : getInlineContentType(item.contentType);
	const etag = `"${item.id}-${item.updatedAt.getTime().toString(36)}-${item.size.toString(36)}"`;
	const headers = new Headers();
	headers.set("Content-Type", inlineType ?? "application/octet-stream");
	headers.set("Content-Disposition", driveContentDisposition(item.name, inlineType !== null));
	headers.set("Accept-Ranges", "bytes");
	headers.set("ETag", etag);
	headers.set("X-Content-Type-Options", "nosniff");
	// Chrome's PDF viewer is blocked by a sandbox or a restrictive default-src (it needs object/plugin loads), and a
	// PDF served with nosniff cannot run script, so it only gets the framing rule.
	headers.set("Content-Security-Policy", inlineType === "application/pdf" ? "frame-ancestors 'self'" : "default-src 'none'; style-src 'unsafe-inline'; sandbox");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Cache-Control", "private, no-store");

	// A client resuming against a file that changed since must start over, which If-Range expresses.
	const ifRange = request.headers.get("If-Range");
	const range = ifRange && ifRange !== etag ? null : parseByteRange(request.headers.get("Range"), item.size);
	if (range === "invalid") {
		headers.set("Content-Range", `bytes */${item.size}`);
		return new Response(null, { status: 416, headers });
	}

	const key = item.r2Key ?? driveObjectKey(item.ownerId, item.id);
	const object = range ? await env.BUCKET.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } }) : await env.BUCKET.get(key);
	if (!object) return new Response("File not found", { status: 404 });
	if (!range) {
		headers.set("Content-Length", String(item.size));
		return new Response(request.method === "HEAD" ? null : object.body, { headers });
	}
	headers.set("Content-Range", `bytes ${range.start}-${range.end}/${item.size}`);
	headers.set("Content-Length", String(range.end - range.start + 1));
	return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
}
