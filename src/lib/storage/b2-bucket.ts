import { awsRequest, AwsError } from "@/lib/aws/client";
import { xmlBlocks, xmlTag } from "@/lib/aws/xml";
import type { AwsConfig } from "@/lib/aws/aws-types";
import type { B2Config, B2HttpMetadata } from "@/lib/storage/b2-types";

/**
 * The slice of the R2 bucket API the app uses (get with a range, put, head, delete, multipart uploads),
 * served by Backblaze B2 over its S3-compatible API. Signing reuses the SigV4 client, so it runs on Workers and Node.
 */
type PutValue = ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null;
type PutOptions = { httpMetadata?: B2HttpMetadata | Headers; customMetadata?: Record<string, string> };

const META_PREFIX = "x-amz-meta-";

const encodePath = (key: string) => `/${key.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`;
const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function toBuffer(value: PutValue): Promise<ArrayBuffer> {
	if (value === null) return new ArrayBuffer(0);
	if (typeof value === "string") return new TextEncoder().encode(value).buffer as ArrayBuffer;
	if (value instanceof ArrayBuffer) return value;
	if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
	if (value instanceof Blob) return value.arrayBuffer();
	return new Response(value).arrayBuffer();
}

function readMetadata(headers: Headers): { httpMetadata: B2HttpMetadata; customMetadata: Record<string, string> } {
	const customMetadata: Record<string, string> = {};
	headers.forEach((value, name) => { if (name.startsWith(META_PREFIX)) customMetadata[name.slice(META_PREFIX.length)] = value; });
	return {
		httpMetadata: {
			contentType: headers.get("content-type") ?? undefined,
			contentDisposition: headers.get("content-disposition") ?? undefined,
			cacheControl: headers.get("cache-control") ?? undefined,
		},
		customMetadata,
	};
}

function objectSize(headers: Headers): number {
	const total = /\/(\d+)$/.exec(headers.get("content-range") ?? "")?.[1];
	return Number(total ?? headers.get("content-length") ?? 0);
}

export class B2Object {
	readonly size: number;
	readonly etag: string;
	readonly uploaded: Date;
	readonly httpMetadata: B2HttpMetadata;
	readonly customMetadata: Record<string, string>;

	constructor(readonly key: string, private readonly response: Response, size?: number) {
		const headers = response.headers;
		this.size = size ?? objectSize(headers);
		this.etag = (headers.get("etag") ?? "").replace(/"/g, "");
		this.uploaded = new Date(headers.get("last-modified") ?? Date.now());
		const meta = readMetadata(headers);
		this.httpMetadata = meta.httpMetadata;
		this.customMetadata = meta.customMetadata;
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
		if (this.httpMetadata.contentDisposition) headers.set("Content-Disposition", this.httpMetadata.contentDisposition);
		if (this.httpMetadata.cacheControl) headers.set("Cache-Control", this.httpMetadata.cacheControl);
	}
}

export class B2Bucket {
	private readonly credentials: AwsConfig;
	private readonly host: string;

	constructor(private readonly config: B2Config) {
		this.credentials = { accessKeyId: config.keyId, secretAccessKey: config.applicationKey, region: config.region };
		this.host = `${config.bucket}.${config.endpoint}`;
	}

	private request(key: string | null, init: { method?: string; query?: Record<string, string>; body?: string | ArrayBuffer; headers?: Record<string, string> } = {}) {
		return awsRequest({ config: this.credentials, service: "s3", host: this.host, path: key === null ? "/" : encodePath(key), ...init });
	}

	private metadataHeaders(options?: PutOptions): Record<string, string> {
		const headers: Record<string, string> = {};
		const meta = options?.httpMetadata;
		const http: B2HttpMetadata = meta instanceof Headers
			? { contentType: meta.get("content-type") ?? undefined, contentDisposition: meta.get("content-disposition") ?? undefined, cacheControl: meta.get("cache-control") ?? undefined }
			: meta ?? {};
		if (http.contentType) headers["Content-Type"] = http.contentType;
		if (http.contentDisposition) headers["Content-Disposition"] = http.contentDisposition;
		if (http.cacheControl) headers["Cache-Control"] = http.cacheControl;
		for (const [name, value] of Object.entries(options?.customMetadata ?? {})) headers[`${META_PREFIX}${name.toLowerCase()}`] = value;
		return headers;
	}

	async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }): Promise<B2Object | null> {
		const range = options?.range;
		const headers: Record<string, string> = {};
		if (range) {
			if (range.suffix != null) headers.Range = `bytes=-${range.suffix}`;
			else {
				const start = range.offset ?? 0;
				headers.Range = range.length != null ? `bytes=${start}-${start + range.length - 1}` : `bytes=${start}-`;
			}
		}
		try { return new B2Object(key, await this.request(key, { headers })); }
		catch (error) { if (error instanceof AwsError && (error.status === 404 || error.code === "NoSuchKey")) return null; throw error; }
	}

	async head(key: string): Promise<B2Object | null> {
		try { return new B2Object(key, await this.request(key, { method: "HEAD" })); }
		catch (error) { if (error instanceof AwsError && error.status === 404) return null; throw error; }
	}

	async put(key: string, value: PutValue, options?: PutOptions): Promise<B2Object> {
		const body = await toBuffer(value);
		const response = await this.request(key, { method: "PUT", body, headers: this.metadataHeaders(options) });
		return new B2Object(key, new Response(null, { headers: response.headers }), body.byteLength);
	}

	async delete(keys: string | string[]): Promise<void> {
		const list = Array.isArray(keys) ? keys : [keys];
		for (let index = 0; index < list.length; index += 10) {
			await Promise.all(list.slice(index, index + 10).map(async (key) => {
				try { await this.request(key, { method: "DELETE" }); }
				catch (error) { if (!(error instanceof AwsError && error.status === 404)) throw error; }
			}));
		}
	}

	/** ListObjectsV2 with the shape of R2's `list`: only key, size and upload time of each object. */
	async list(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; truncated: boolean; cursor?: string }> {
		const query: Record<string, string> = { "list-type": "2", "max-keys": String(Math.min(options.limit ?? 1000, 1000)) };
		if (options.prefix) query.prefix = options.prefix;
		if (options.cursor) query["continuation-token"] = options.cursor;
		const xml = await (await this.request(null, { query })).text();
		const objects = xmlBlocks(xml, "Contents").map((block) => ({
			key: xmlTag(block, "Key") ?? "",
			size: Number(xmlTag(block, "Size") ?? 0),
			uploaded: new Date(xmlTag(block, "LastModified") ?? Date.now()),
		})).filter((object) => object.key);
		const truncated = xmlTag(xml, "IsTruncated") === "true";
		return { objects, truncated, cursor: truncated ? xmlTag(xml, "NextContinuationToken") ?? undefined : undefined };
	}

	async createMultipartUpload(key: string, options?: { httpMetadata?: B2HttpMetadata; customMetadata?: Record<string, string> }) {
		const response = await this.request(key, { method: "POST", query: { uploads: "" }, headers: this.metadataHeaders(options) });
		const uploadId = xmlTag(await response.text(), "UploadId");
		if (!uploadId) throw new Error("Backblaze did not return an upload id");
		return this.resumeMultipartUpload(key, uploadId);
	}

	resumeMultipartUpload(key: string, uploadId: string) {
		return {
			key,
			uploadId,
			uploadPart: async (partNumber: number, value: PutValue) => {
				if (!Number.isInteger(partNumber) || partNumber < 1) throw new Error("Invalid part number");
				const response = await this.request(key, { method: "PUT", query: { partNumber: String(partNumber), uploadId }, body: await toBuffer(value) });
				return { partNumber, etag: (response.headers.get("etag") ?? "").replace(/"/g, "") };
			},
			abort: async () => { await this.request(key, { method: "DELETE", query: { uploadId } }); },
			complete: async (parts: { partNumber: number; etag: string }[]) => {
				const body = `<CompleteMultipartUpload>${[...parts].sort((a, b) => a.partNumber - b.partNumber)
					.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${escapeXml(part.etag)}"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
				const response = await this.request(key, { method: "POST", query: { uploadId }, body, headers: { "Content-Type": "application/xml" } });
				// A 200 can still carry an <Error> document.
				const text = await response.text();
				if (/<Error>/.test(text)) throw new Error(xmlTag(text, "Message") ?? "Multipart upload failed");
				const head = await this.head(key);
				if (!head) throw new Error("Uploaded object not found");
				return head;
			},
		};
	}
}

export function openB2Bucket(config: B2Config): R2Bucket {
	return new B2Bucket(config) as unknown as R2Bucket;
}
