import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

/**
 * The R2 bucket API over a directory. Objects are files under `root`; the
 * HTTP and custom metadata R2 would keep ride in a `.meta.json` sidecar.
 * Covers what the app uses: get (with a byte range), put, delete, head.
 */
type StoredMeta = {
	httpMetadata?: { contentType?: string; contentDisposition?: string; cacheControl?: string };
	customMetadata?: Record<string, string>;
	size: number;
	uploaded: string;
	etag: string;
};

function assertInside(root: string, path: string) {
	const full = resolve(path);
	if (full !== root && !full.startsWith(root + sep)) throw new Error("Object key escapes the bucket root");
	return full;
}

class FileObject {
	constructor(
		readonly key: string,
		private readonly path: string,
		private readonly meta: StoredMeta,
		private readonly range?: { offset: number; length: number },
	) {}

	get size() {
		return this.meta.size;
	}
	get etag() {
		return this.meta.etag;
	}
	get httpEtag() {
		return `"${this.meta.etag}"`;
	}
	get uploaded() {
		return new Date(this.meta.uploaded);
	}
	get httpMetadata() {
		return this.meta.httpMetadata ?? {};
	}
	get customMetadata() {
		return this.meta.customMetadata ?? {};
	}
	get version() {
		return this.meta.etag;
	}
	get body(): ReadableStream<Uint8Array> {
		const options = this.range ? { start: this.range.offset, end: this.range.offset + this.range.length - 1 } : undefined;
		return Readable.toWeb(createReadStream(this.path, options)) as ReadableStream<Uint8Array>;
	}
	get bodyUsed() {
		return false;
	}
	async arrayBuffer(): Promise<ArrayBuffer> {
		const buffer = await readFile(this.path);
		const slice = this.range ? buffer.subarray(this.range.offset, this.range.offset + this.range.length) : buffer;
		return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
	}
	async text(): Promise<string> {
		return Buffer.from(await this.arrayBuffer()).toString("utf8");
	}
	async json<T>(): Promise<T> {
		return JSON.parse(await this.text()) as T;
	}
	async blob(): Promise<Blob> {
		return new Blob([await this.arrayBuffer()], { type: this.meta.httpMetadata?.contentType });
	}
	writeHttpMetadata(headers: Headers) {
		if (this.meta.httpMetadata?.contentType) headers.set("Content-Type", this.meta.httpMetadata.contentType);
		if (this.meta.httpMetadata?.contentDisposition) headers.set("Content-Disposition", this.meta.httpMetadata.contentDisposition);
		if (this.meta.httpMetadata?.cacheControl) headers.set("Cache-Control", this.meta.httpMetadata.cacheControl);
	}
}

export class FileBucket {
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	private pathFor(key: string) {
		return assertInside(this.root, join(this.root, key));
	}

	private async readMeta(key: string): Promise<StoredMeta | null> {
		try {
			return JSON.parse(await readFile(`${this.pathFor(key)}.meta.json`, "utf8")) as StoredMeta;
		} catch {
			try {
				const info = await stat(this.pathFor(key));
				return { size: info.size, uploaded: info.mtime.toISOString(), etag: String(info.mtimeMs) };
			} catch {
				return null;
			}
		}
	}

	async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
		const meta = await this.readMeta(key);
		if (!meta) return null;
		let range: { offset: number; length: number } | undefined;
		if (options?.range) {
			const offset = options.range.suffix != null ? Math.max(meta.size - options.range.suffix, 0) : options.range.offset ?? 0;
			const length = Math.min(options.range.length ?? meta.size - offset, meta.size - offset);
			range = { offset, length };
		}
		return new FileObject(key, this.pathFor(key), meta, range);
	}

	async head(key: string) {
		const meta = await this.readMeta(key);
		return meta ? new FileObject(key, this.pathFor(key), meta) : null;
	}

	async put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null,
		options?: { httpMetadata?: StoredMeta["httpMetadata"] | Headers; customMetadata?: Record<string, string> },
	) {
		const path = this.pathFor(key);
		await mkdir(dirname(path), { recursive: true });
		let buffer: Buffer;
		if (value === null) buffer = Buffer.alloc(0);
		else if (typeof value === "string") buffer = Buffer.from(value);
		else if (value instanceof ArrayBuffer) buffer = Buffer.from(value);
		else if (ArrayBuffer.isView(value)) buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		else if (value instanceof Blob) buffer = Buffer.from(await value.arrayBuffer());
		else buffer = Buffer.from(await new Response(value).arrayBuffer());
		const httpMetadata =
			options?.httpMetadata instanceof Headers
				? { contentType: options.httpMetadata.get("content-type") ?? undefined }
				: options?.httpMetadata;
		const meta: StoredMeta = {
			httpMetadata,
			customMetadata: options?.customMetadata,
			size: buffer.byteLength,
			uploaded: new Date().toISOString(),
			etag: `${Date.now().toString(16)}-${buffer.byteLength.toString(16)}`,
		};
		await writeFile(path, buffer);
		await writeFile(`${path}.meta.json`, JSON.stringify(meta));
		return new FileObject(key, path, meta);
	}

	async delete(keys: string | string[]) {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			const path = this.pathFor(key);
			await rm(path, { force: true });
			await rm(`${path}.meta.json`, { force: true });
		}
	}

	async list() {
		throw new Error("FileBucket.list is not implemented");
	}
}

export function openFileBucket(root: string): R2Bucket {
	return new FileBucket(root) as unknown as R2Bucket;
}
