/**
 * Vercel Blob as `env.BUCKET`: the slice of the R2 bucket API the app uses, over a private Blob store. Used on
 * Vercel when no S3 or Backblaze bucket is configured. This is the only module that imports the SDK, and only
 * the Vercel env imports it.
 *
 * Blob has no custom metadata, so `customMetadata` is accepted and dropped, and it cannot abort a multipart
 * upload (unfinished ones are left to Vercel).
 */
import {
	BlobNotFoundError,
	completeMultipartUpload,
	createMultipartUpload,
	del,
	get,
	head,
	issueSignedToken,
	list,
	parseStoreIdFromDelegationToken,
	presignUrl,
	put,
	uploadPart,
} from "@vercel/blob";
import type { UploadPresigner } from "@/lib/uploads/types";

export type BlobCredentials = { storeId?: string; token?: string };

type Vars = Record<string, string | undefined>;

/** A connected store sets `BLOB_STORE_ID` (the function's OIDC token signs in) or `BLOB_READ_WRITE_TOKEN`. */
export function readBlobCredentials(vars: Vars): BlobCredentials | null {
	const storeId = vars.BLOB_STORE_ID?.trim();
	if (storeId) return { storeId };
	const token = vars.BLOB_READ_WRITE_TOKEN?.trim();
	return token ? { token } : null;
}

/** Sent with a browser's or the relay's PUT, as the SDK does. The version is the one this SDK release speaks. */
const API_VERSION = "13";
/** The shortest cache Blob allows. Reads bypass the cache anyway, since the app overwrites some keys. */
const CACHE_SECONDS = 60;
/** Larger bodies are sent in parts by the SDK. */
const MULTIPART_BYTES = 8 * 1024 * 1024;
const DELETE_BATCH = 100;

type PutValue = ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null;
type HttpMetadata = { contentType?: string };
type PutOptions = { httpMetadata?: HttpMetadata | Headers; customMetadata?: Record<string, string> };
type Range = { offset?: number; length?: number; suffix?: number };
type ObjectInfo = { size: number; etag: string; uploaded: Date; contentType?: string };

async function toBuffer(value: PutValue): Promise<Buffer> {
	if (value === null) return Buffer.alloc(0);
	if (typeof value === "string") return Buffer.from(value);
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return Buffer.from(await (value instanceof Blob ? value.arrayBuffer() : new Response(value).arrayBuffer()));
}

function contentTypeOf(options?: PutOptions): string | undefined {
	const meta = options?.httpMetadata;
	if (meta instanceof Headers) return meta.get("content-type") ?? undefined;
	return meta?.contentType;
}

const unquote = (etag: string) => etag.replace(/"/g, "");

/** The SDK puts a pathname into the download URL as it is, so `#`, `?` and `%` in a filename need encoding. */
const urlPath = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export class VercelBlobObject {
	readonly size: number;
	readonly etag: string;
	readonly uploaded: Date;
	readonly httpMetadata: HttpMetadata;
	readonly customMetadata: Record<string, string> = {};

	constructor(readonly key: string, info: ObjectInfo, private readonly response: Response = new Response(null)) {
		this.size = info.size;
		this.etag = unquote(info.etag);
		this.uploaded = info.uploaded;
		this.httpMetadata = { contentType: info.contentType };
	}

	get httpEtag() { return `"${this.etag}"`; }
	get version() { return this.etag; }
	get body(): ReadableStream<Uint8Array> { return (this.response.body ?? new Blob([]).stream()) as ReadableStream<Uint8Array>; }
	get bodyUsed() { return this.response.bodyUsed; }
	arrayBuffer() { return this.response.arrayBuffer(); }
	text() { return this.response.text(); }
	json<T>() { return this.response.json() as Promise<T>; }
	blob() { return this.response.blob(); }

	writeHttpMetadata(headers: Headers) {
		if (this.httpMetadata.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
	}
}

export class VercelBlobBucket {
	constructor(private readonly credentials: BlobCredentials) {}

	private options() {
		return { ...this.credentials, access: "private" as const };
	}

	private writeOptions(contentType?: string) {
		return { ...this.options(), addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: CACHE_SECONDS, ...(contentType ? { contentType } : {}) };
	}

	async head(key: string): Promise<VercelBlobObject | null> {
		try {
			const info = await head(key, this.credentials);
			return new VercelBlobObject(key, { size: info.size, etag: info.etag, uploaded: info.uploadedAt, contentType: info.contentType });
		} catch (error) {
			if (error instanceof BlobNotFoundError) return null;
			throw error;
		}
	}

	async get(key: string, options?: { range?: Range }): Promise<VercelBlobObject | null> {
		const range = options?.range;
		// A compressed response would report the compressed length.
		const headers: Record<string, string> = { "accept-encoding": "identity" };
		if (range) {
			const start = range.offset ?? 0;
			headers.range = range.suffix != null ? `bytes=-${range.suffix}` : `bytes=${start}-${range.length != null ? start + range.length - 1 : ""}`;
		}
		const result = await get(urlPath(key), { ...this.options(), useCache: false, headers });
		if (!result || result.statusCode !== 200) return null;
		const total = /\/(\d+)$/.exec(result.headers.get("content-range") ?? "")?.[1];
		const length = total ?? result.headers.get("content-length");
		let size = Number(length);
		if (length === null) size = (await this.head(key))?.size ?? 0;
		let response = new Response(result.stream);
		// A server that ignored the range answers with the whole object; cut the range out here.
		if (range && !total) {
			const whole = await response.arrayBuffer();
			size = whole.byteLength;
			const start = range.suffix != null ? Math.max(size - range.suffix, 0) : (range.offset ?? 0);
			response = new Response(whole.slice(start, range.suffix == null && range.length != null ? start + range.length : size));
		}
		return new VercelBlobObject(key, { size, etag: result.blob.etag, uploaded: result.blob.uploadedAt, contentType: result.blob.contentType ?? undefined }, response);
	}

	async put(key: string, value: PutValue, options?: PutOptions): Promise<VercelBlobObject> {
		const body = await toBuffer(value);
		const contentType = contentTypeOf(options);
		const result = await put(key, body, { ...this.writeOptions(contentType), multipart: body.byteLength > MULTIPART_BYTES });
		return new VercelBlobObject(key, { size: body.byteLength, etag: result.etag, uploaded: new Date(), contentType });
	}

	async delete(keys: string | string[]): Promise<void> {
		const all = Array.isArray(keys) ? keys : [keys];
		for (let index = 0; index < all.length; index += DELETE_BATCH) {
			try {
				await del(all.slice(index, index + DELETE_BATCH), this.credentials);
			} catch (error) {
				if (!(error instanceof BlobNotFoundError)) throw error;
			}
		}
	}

	async list(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; truncated: boolean; cursor?: string }> {
		const result = await list({ ...this.credentials, prefix: options.prefix, cursor: options.cursor, limit: Math.min(options.limit ?? 1000, 1000) });
		return {
			objects: result.blobs.map((blob) => ({ key: blob.pathname, size: blob.size, uploaded: blob.uploadedAt })),
			truncated: result.hasMore,
			cursor: result.hasMore ? result.cursor : undefined,
		};
	}

	async createMultipartUpload(key: string, options?: PutOptions) {
		const upload = await createMultipartUpload(key, this.writeOptions(contentTypeOf(options)));
		// Blob needs both values to continue an upload; the app stores one id.
		return this.resumeMultipartUpload(key, JSON.stringify([upload.key, upload.uploadId]));
	}

	resumeMultipartUpload(key: string, uploadId: string) {
		const target = () => {
			const [blobKey, blobUploadId] = JSON.parse(uploadId) as [string, string];
			return { ...this.writeOptions(), key: blobKey, uploadId: blobUploadId };
		};
		return {
			key,
			uploadId,
			uploadPart: async (partNumber: number, value: PutValue) => {
				const part = await uploadPart(key, await toBuffer(value), { ...target(), partNumber });
				return { partNumber, etag: part.etag };
			},
			abort: async () => {},
			complete: async (parts: { partNumber: number; etag: string }[]) => {
				await completeMultipartUpload(key, [...parts].sort((a, b) => a.partNumber - b.partNumber), target());
				const object = await this.head(key);
				if (!object) throw new Error("Uploaded object not found");
				return object;
			},
		};
	}

	/** Where to PUT at most `size` bytes to `key`, straight to the store, and the headers to send. */
	presignUpload: UploadPresigner = async (key, size, expiresSeconds) => {
		const validUntil = Date.now() + expiresSeconds * 1000;
		const signed = await issueSignedToken({ ...this.credentials, pathname: key, operations: ["put"], maximumSizeInBytes: size, validUntil });
		const { presignedUrl } = await presignUrl(signed, { operation: "put", pathname: key, access: "private", maximumSizeInBytes: size, addRandomSuffix: false, allowOverwrite: true, validUntil });
		return {
			url: presignedUrl,
			headers: {
				"x-api-version": API_VERSION,
				"x-vercel-blob-access": "private",
				"x-vercel-blob-store-id": parseStoreIdFromDelegationToken(signed.delegationToken),
			},
		};
	};
}
