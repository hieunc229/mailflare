import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { isVercelRuntime } from "@/lib/runtime";
import { getObjectStorageConfig } from "@/lib/storage/b2-config";
import { presignPutUrl } from "@/lib/storage/b2-bucket";
import { REQUEST_UPLOAD_PREFIX, UPLOAD_KEY_HEADER, UPLOAD_TYPE_HEADER } from "./constants";
import type { UploadPresigner, UploadTicket } from "./types";

export { MAX_UPLOAD_BYTES } from "./constants";

/** Time the client has to start its PUT. */
const TICKET_SECONDS = 15 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Set by the Vercel env when Vercel Blob is the storage. An S3 or Backblaze bucket takes precedence. */
function blobPresigner(env: CloudflareEnv): UploadPresigner | undefined {
	return (env as unknown as { UPLOAD_PRESIGNER?: UploadPresigner }).UPLOAD_PRESIGNER;
}

export function directUploadsEnabled(env: CloudflareEnv): boolean {
	return isVercelRuntime(env) && !!(getObjectStorageConfig(env) || blobPresigner(env));
}

export async function createUploadTicket(env: CloudflareEnv, owner: string, size: number): Promise<UploadTicket> {
	const config = getObjectStorageConfig(env);
	const presign = blobPresigner(env);
	const key = `${REQUEST_UPLOAD_PREFIX}/${owner}/${crypto.randomUUID()}`;
	if (config) return { key, url: await presignPutUrl(config, key, size, TICKET_SECONDS) };
	if (!presign) throw new Error("Object storage is not configured");
	return { key, ...(await presign(key, size, TICKET_SECONDS)) };
}

/** The bytes of an object `owner` uploaded. A key outside the owner's prefix is treated as missing. */
export async function readUpload(env: CloudflareEnv, key: string, owner: string, maxBytes: number): Promise<ArrayBuffer> {
	const prefix = `${REQUEST_UPLOAD_PREFIX}/${owner}/`;
	const object = key.startsWith(prefix) && UUID.test(key.slice(prefix.length)) ? await env.BUCKET.get(key) : null;
	if (!object) throw new Error("Upload not found");
	if (object.size > maxBytes) throw new RequestBodyTooLargeError("Request body is too large");
	return object.arrayBuffer();
}

/**
 * The request with its body restored from storage, for a route that has already authenticated `owner`. Any
 * request that names no upload, and every request off Vercel, is returned unchanged. The object is deleted
 * once read.
 */
export async function resolveUploadedRequest(env: CloudflareEnv, request: Request, owner: string, maxBytes: number): Promise<Request> {
	const key = request.headers.get(UPLOAD_KEY_HEADER);
	if (!key || !directUploadsEnabled(env)) return request;
	const body = await readUpload(env, key, owner, maxBytes);
	await env.BUCKET.delete(key);
	const headers = new Headers(request.headers);
	const type = headers.get(UPLOAD_TYPE_HEADER);
	headers.delete(UPLOAD_KEY_HEADER);
	headers.delete(UPLOAD_TYPE_HEADER);
	if (type) headers.set("content-type", type);
	else headers.delete("content-type");
	headers.set("content-length", String(body.byteLength));
	return new Request(request.url, { method: request.method, headers, body });
}
