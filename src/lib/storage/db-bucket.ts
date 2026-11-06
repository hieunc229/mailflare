import { withDatabase } from "@/db/with-database";
import type { B2HttpMetadata } from "@/lib/storage/b2-types";

/**
 * The slice of the R2 bucket API the app uses (get with a range, put, head, delete, list, multipart
 * uploads), served by the app's own database. Objects are rows in `storage_objects`; their bytes
 * live as base64 chunks in `storage_object_chunks`, so a single object is never one huge row and
 * every driver — D1, SQLite, PostgreSQL, MySQL and the HTTP-only ones like Neon or PlanetScale that
 * JSON-serialize bound parameters — stores it the same way.
 *
 * This is a fallback store for environments without R2, B2 or S3 (set STORAGE_DRIVER=database, or
 * leave every object store unconfigured). Databases keep far less space than a bucket — D1's free
 * tier tops out around 500 MB total — so uploads are refused past MAX_OBJECT_BYTES.
 */
type PutValue = ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null;
type PutOptions = { httpMetadata?: B2HttpMetadata | Headers; customMetadata?: Record<string, string> };
type Range = { offset: number; length: number };

/** Raw bytes per chunk row; 768 KiB encodes to exactly 1 MiB of base64, under D1's ~2 MB row limit. */
const CHUNK_BYTES = 768 * 1024;
/** Multipart parts are ordinary objects under this prefix, rekeyed (never copied) on completion. */
const STAGING_PREFIX = "~db-multipart/";
/** Chunks per write batch: ~8 MiB of base64 per round trip keeps each statement batch well inside D1's request cap. */
const BATCH_CHUNKS = 8;
/**
 * The largest object this store accepts. Chunks are cheap, but the database also holds mail and
 * settings and D1's free tier is small; 256 MiB is deliberately conservative for a fallback.
 */
export const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

/** A stored chunk's place in the object's byte stream: index in storage_object_chunks, start offset, length. */
type ChunkPiece = { index: number; start: number; bytes: number };

type StoredMeta = {
	key: string;
	size: number;
	etag: string;
	uploaded: number;
	httpMetadata: B2HttpMetadata;
	customMetadata: Record<string, string>;
};

async function toBuffer(value: PutValue): Promise<ArrayBuffer> {
	if (value === null) return new ArrayBuffer(0);
	if (typeof value === "string") return new TextEncoder().encode(value).buffer as ArrayBuffer;
	if (value instanceof ArrayBuffer) return value;
	if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
	if (value instanceof Blob) return value.arrayBuffer();
	return new Response(value).arrayBuffer();
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/** The first key after `prefix`'s whole subtree, so `>= prefix AND < upper` names a prefix without LIKE. */
function prefixUpperBound(prefix: string): string | null {
	for (let index = prefix.length - 1; index >= 0; index -= 1) {
		const code = prefix.charCodeAt(index);
		if (code !== 0xffff) return prefix.slice(0, index) + String.fromCharCode(code + 1);
	}
	return null;
}

const STAGING_UPPER = prefixUpperBound(STAGING_PREFIX) as string;

function parseMetadata(value: unknown): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(typeof value === "string" ? value : "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

function httpMetadataOf(options?: PutOptions): B2HttpMetadata {
	const meta = options?.httpMetadata;
	if (meta instanceof Headers) {
		return {
			contentType: meta.get("content-type") ?? undefined,
			contentDisposition: meta.get("content-disposition") ?? undefined,
			cacheControl: meta.get("cache-control") ?? undefined,
		};
	}
	return meta ?? {};
}

const newEtag = () => crypto.randomUUID().replace(/-/g, "");
const nowSeconds = () => Math.floor(Date.now() / 1000);

export class DatabaseObject {
	readonly size: number;
	readonly etag: string;
	readonly uploaded: Date;
	readonly httpMetadata: B2HttpMetadata;
	readonly customMetadata: Record<string, string>;
	private used = false;

	constructor(
		readonly key: string,
		meta: StoredMeta,
		private readonly readRange: (range: Range) => Promise<Uint8Array>,
		private readonly readChunk: (index: number) => Promise<Uint8Array | null>,
		private readonly findPieces: (range: Range) => Promise<ChunkPiece[]>,
		private readonly range?: Range,
	) {
		this.size = meta.size;
		this.etag = meta.etag;
		this.uploaded = new Date(meta.uploaded * 1000);
		this.httpMetadata = meta.httpMetadata;
		this.customMetadata = meta.customMetadata;
	}

	get httpEtag() {
		return `"${this.etag}"`;
	}

	get version() {
		return this.etag;
	}

	private requestedRange(): Range {
		return this.range ?? { offset: 0, length: this.size };
	}

	/** Streams one stored chunk per pull, so reading a large object does not buffer it whole. */
	get body(): ReadableStream<Uint8Array> {
		this.used = true;
		const range = this.requestedRange();
		let pieces: ChunkPiece[] | undefined;
		return new ReadableStream<Uint8Array>({
			start: async () => {
				pieces = await this.findPieces(range);
			},
			pull: async (controller) => {
				const piece = pieces?.shift();
				if (!piece) {
					controller.close();
					return;
				}
				const chunk = await this.readChunk(piece.index);
				if (!chunk) {
					// A torn write is missing a chunk; end the stream rather than ship shifted bytes.
					pieces = [];
					controller.close();
					return;
				}
				const from = Math.max(range.offset - piece.start, 0);
				const to = Math.min(chunk.length, range.offset + range.length - piece.start);
				if (to > from) controller.enqueue(chunk.subarray(from, to));
			},
		});
	}

	get bodyUsed() {
		return this.used;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		this.used = true;
		const bytes = await this.readRange(this.requestedRange());
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(await this.arrayBuffer());
	}

	async json<T>(): Promise<T> {
		return JSON.parse(await this.text()) as T;
	}

	async blob(): Promise<Blob> {
		return new Blob([await this.arrayBuffer()], { type: this.httpMetadata.contentType });
	}

	writeHttpMetadata(headers: Headers) {
		if (this.httpMetadata.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
		if (this.httpMetadata.contentDisposition) headers.set("Content-Disposition", this.httpMetadata.contentDisposition);
		if (this.httpMetadata.cacheControl) headers.set("Cache-Control", this.httpMetadata.cacheControl);
	}
}

type MetaRow = {
	object_key: unknown;
	size: unknown;
	etag: unknown;
	uploaded: unknown;
	http_metadata: unknown;
	custom_metadata: unknown;
};

export class DatabaseBucket {
	/** Lets getStorageStatus name the provider without importing this module. */
	readonly provider = "database";
	private database: D1Database | undefined;

	constructor(private readonly env: CloudflareEnv) {}

	/**
	 * The database is resolved on first use, not at construction: `withDatabase(withStorage(env))`
	 * wraps storage before the database swap runs, so env.DB here is still the raw binding. Resolving
	 * through withDatabase lazily lands on the same configured database callers see.
	 */
	private db(): D1Database {
		if (!this.database) {
			const db = withDatabase(this.env).DB;
			if (!db) throw new Error("Database object storage needs the DB binding or DATABASE_URL to be configured.");
			this.database = db;
		}
		return this.database;
	}

	private async metaRow(key: string): Promise<StoredMeta | null> {
		const row = await this.db()
			.prepare("SELECT object_key, size, etag, uploaded, http_metadata, custom_metadata FROM storage_objects WHERE object_key = ?")
			.bind(key)
			.first<MetaRow>();
		if (!row) return null;
		return {
			key: String(row.object_key),
			size: Number(row.size),
			etag: String(row.etag),
			uploaded: Number(row.uploaded),
			httpMetadata: parseMetadata(row.http_metadata) as B2HttpMetadata,
			customMetadata: parseMetadata(row.custom_metadata),
		};
	}

	private object(key: string, meta: StoredMeta, range?: Range): DatabaseObject {
		return new DatabaseObject(
			key,
			meta,
			(requested) => this.readRange(key, requested),
			(index) => this.readChunk(key, index),
			(requested) => this.piecesFor(key, requested),
			range,
		);
	}

	private async readChunk(key: string, index: number): Promise<Uint8Array | null> {
		const row = await this.db()
			.prepare("SELECT data FROM storage_object_chunks WHERE object_key = ? AND chunk_index = ?")
			.bind(key, index)
			.first<{ data: unknown }>();
		return row ? fromBase64(String(row.data)) : null;
	}

	/**
	 * The stored chunks a byte range touches. Part rekeying leaves each part's original chunk
	 * boundaries in place, so positions come from the recorded per-chunk sizes, not index math.
	 */
	private async piecesFor(key: string, range: Range): Promise<ChunkPiece[]> {
		const { results } = await this.db()
			.prepare("SELECT chunk_index, bytes FROM storage_object_chunks WHERE object_key = ? ORDER BY chunk_index")
			.bind(key)
			.all<{ chunk_index: unknown; bytes: unknown }>();
		const pieces: ChunkPiece[] = [];
		let position = 0;
		const end = range.offset + range.length;
		for (const row of results) {
			const bytes = Number(row.bytes);
			if (position + bytes > range.offset && position < end) pieces.push({ index: Number(row.chunk_index), start: position, bytes });
			position += bytes;
		}
		return pieces;
	}

	private async readRange(key: string, range: Range): Promise<Uint8Array> {
		if (range.length <= 0) return new Uint8Array(0);
		const pieces = await this.piecesFor(key, range);
		if (!pieces.length) return new Uint8Array(0);
		const { results } = await this.db()
			.prepare("SELECT chunk_index, data FROM storage_object_chunks WHERE object_key = ? AND chunk_index >= ? AND chunk_index <= ? ORDER BY chunk_index")
			.bind(key, pieces[0].index, pieces[pieces.length - 1].index)
			.all<{ chunk_index: unknown; data: unknown }>();
		const chunks = new Map<number, Uint8Array>();
		for (const row of results) chunks.set(Number(row.chunk_index), fromBase64(String(row.data)));
		const out = new Uint8Array(range.length);
		let copiedEnd = 0;
		for (const piece of pieces) {
			const chunk = chunks.get(piece.index);
			if (!chunk) break;
			const from = Math.max(range.offset - piece.start, 0);
			const to = Math.min(chunk.length, range.offset + range.length - piece.start);
			if (to > from) {
				out.set(chunk.subarray(from, to), piece.start + from - range.offset);
				copiedEnd = piece.start + to - range.offset;
			}
		}
		return out.subarray(0, copiedEnd);
	}

	/** Deletes then rewrites an object row and its chunks, flushing batches of a few chunks each. */
	private async writeObject(key: string, body: ArrayBuffer, etag: string, httpMetadata: string, customMetadata: string): Promise<void> {
		const db = this.db();
		const bytes = new Uint8Array(body);
		const statements = [
			db.prepare("DELETE FROM storage_object_chunks WHERE object_key = ?").bind(key),
			db.prepare("DELETE FROM storage_objects WHERE object_key = ?").bind(key),
			db
				.prepare("INSERT INTO storage_objects (object_key, size, etag, uploaded, http_metadata, custom_metadata) VALUES (?, ?, ?, ?, ?, ?)")
				.bind(key, body.byteLength, etag, nowSeconds(), httpMetadata, customMetadata),
		];
		let index = 0;
		let pending = 0;
		for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
			const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
			statements.push(db.prepare("INSERT INTO storage_object_chunks (object_key, chunk_index, bytes, data) VALUES (?, ?, ?, ?)").bind(key, index, chunk.length, toBase64(chunk)));
			index += 1;
			pending += 1;
			if (pending >= BATCH_CHUNKS) {
				await db.batch(statements.splice(0));
				pending = 0;
			}
		}
		if (statements.length) await db.batch(statements);
	}

	private resolveRange(meta: StoredMeta, range?: { offset?: number; length?: number; suffix?: number }): Range | undefined {
		if (!range) return undefined;
		const offset = range.suffix != null ? Math.max(meta.size - range.suffix, 0) : Math.min(Math.max(range.offset ?? 0, 0), meta.size);
		const length = Math.max(Math.min(range.length ?? meta.size - offset, meta.size - offset), 0);
		return { offset, length };
	}

	async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }): Promise<DatabaseObject | null> {
		const meta = await this.metaRow(key);
		if (!meta) return null;
		return this.object(key, meta, this.resolveRange(meta, options?.range));
	}

	async head(key: string): Promise<DatabaseObject | null> {
		const meta = await this.metaRow(key);
		return meta ? this.object(key, meta) : null;
	}

	async put(key: string, value: PutValue, options?: PutOptions): Promise<DatabaseObject> {
		const body = await toBuffer(value);
		if (body.byteLength > MAX_OBJECT_BYTES) {
			throw new Error(`Object is ${body.byteLength} bytes; database object storage is limited to ${MAX_OBJECT_BYTES} bytes. Use R2, B2 or S3 for larger objects.`);
		}
		const httpMetadata = httpMetadataOf(options);
		const meta: StoredMeta = {
			key,
			size: body.byteLength,
			etag: newEtag(),
			uploaded: nowSeconds(),
			httpMetadata,
			customMetadata: options?.customMetadata ?? {},
		};
		await this.writeObject(key, body, meta.etag, JSON.stringify(meta.httpMetadata), JSON.stringify(meta.customMetadata));
		return this.object(key, meta);
	}

	async delete(keys: string | string[]): Promise<void> {
		const db = this.db();
		const list = Array.isArray(keys) ? keys : [keys];
		for (let index = 0; index < list.length; index += 50) {
			const statements = list.slice(index, index + 50).flatMap((key) => [
				db.prepare("DELETE FROM storage_object_chunks WHERE object_key = ?").bind(key),
				db.prepare("DELETE FROM storage_objects WHERE object_key = ?").bind(key),
			]);
			await db.batch(statements);
		}
	}

	/** Key order, with the multipart staging subtree hidden like R2 hides unfinished uploads. */
	async list(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; truncated: boolean; cursor?: string }> {
		const limit = Math.min(options.limit ?? 1000, 1000);
		const clauses: string[] = ["NOT (object_key >= ? AND object_key < ?)"];
		const params: unknown[] = [STAGING_PREFIX, STAGING_UPPER];
		if (options.prefix) {
			clauses.push("object_key >= ?");
			params.push(options.prefix);
			const upper = prefixUpperBound(options.prefix);
			if (upper) {
				clauses.push("object_key < ?");
				params.push(upper);
			}
		}
		if (options.cursor) {
			clauses.push("object_key > ?");
			params.push(options.cursor);
		}
		const { results } = await this.db()
			.prepare(`SELECT object_key, size, uploaded FROM storage_objects WHERE ${clauses.join(" AND ")} ORDER BY object_key LIMIT ${limit + 1}`)
			.bind(...params)
			.all<{ object_key: unknown; size: unknown; uploaded: unknown }>();
		const page = results.slice(0, limit);
		const objects = page.map((row) => ({ key: String(row.object_key), size: Number(row.size), uploaded: new Date(Number(row.uploaded) * 1000) }));
		const truncated = results.length > limit;
		return { objects, truncated, cursor: truncated ? objects[objects.length - 1]?.key : undefined };
	}

	private stagingMarker(uploadId: string): string {
		return `${STAGING_PREFIX}${uploadId}`;
	}

	private stagingPart(uploadId: string, partNumber: number): string {
		return `${STAGING_PREFIX}${uploadId}/${partNumber}`;
	}

	async createMultipartUpload(key: string, options?: PutOptions) {
		const uploadId = crypto.randomUUID();
		// The marker row carries the upload's descriptor — final key and the metadata the finished
		// object should get — in its custom_metadata column, since it is never a listed object.
		const descriptor = JSON.stringify({ key, httpMetadata: httpMetadataOf(options), customMetadata: options?.customMetadata ?? {} });
		await this.db()
			.prepare("INSERT INTO storage_objects (object_key, size, etag, uploaded, http_metadata, custom_metadata) VALUES (?, 0, ?, ?, '{}', ?)")
			.bind(this.stagingMarker(uploadId), newEtag(), nowSeconds(), descriptor)
			.run();
		return this.resumeMultipartUpload(key, uploadId);
	}

	resumeMultipartUpload(key: string, uploadId: string) {
		const marker = this.stagingMarker(uploadId);
		return {
			key,
			uploadId,
			uploadPart: async (partNumber: number, value: PutValue) => {
				if (!Number.isInteger(partNumber) || partNumber < 1) throw new Error("Invalid part number");
				if (!(await this.metaRow(marker))) throw new Error("Unknown multipart upload");
				const body = await toBuffer(value);
				if (body.byteLength > MAX_OBJECT_BYTES) {
					throw new Error(`Part is ${body.byteLength} bytes; database object storage is limited to ${MAX_OBJECT_BYTES} bytes. Use R2, B2 or S3 for larger objects.`);
				}
				const etag = newEtag();
				await this.writeObject(this.stagingPart(uploadId, partNumber), body, etag, "{}", "{}");
				return { partNumber, etag };
			},
			abort: async () => {
				const db = this.db();
				const upper = prefixUpperBound(marker) as string;
				await db.batch([
					db.prepare("DELETE FROM storage_object_chunks WHERE object_key >= ? AND object_key < ?").bind(marker, upper),
					db.prepare("DELETE FROM storage_objects WHERE object_key >= ? AND object_key < ?").bind(marker, upper),
				]);
			},
			complete: async (parts: { partNumber: number; etag: string }[]) => {
				const db = this.db();
				const markerRow = await this.metaRow(marker);
				if (!markerRow) throw new Error("Unknown multipart upload");
				// metaRow already parsed the descriptor JSON stored in the marker's custom_metadata.
				const descriptor = markerRow.customMetadata as unknown as { key?: string; httpMetadata?: B2HttpMetadata; customMetadata?: Record<string, string> };
				const finalKey = descriptor.key ?? key;
				const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
				if (!sorted.length) throw new Error("No parts to complete");
				if (new Set(sorted.map((part) => part.partNumber)).size !== sorted.length) throw new Error("Duplicate part numbers");
				const staged: { key: string; size: number }[] = [];
				let size = 0;
				for (const part of sorted) {
					const row = await this.metaRow(this.stagingPart(uploadId, part.partNumber));
					if (!row) throw new Error(`Multipart part ${part.partNumber} is missing`);
					staged.push(row);
					size += row.size;
				}
				if (size > MAX_OBJECT_BYTES) {
					throw new Error(`Object is ${size} bytes; database object storage is limited to ${MAX_OBJECT_BYTES} bytes. Use R2, B2 or S3 for larger objects.`);
				}
				const upper = prefixUpperBound(marker) as string;
				const statements = [
					db.prepare("DELETE FROM storage_object_chunks WHERE object_key = ?").bind(finalKey),
					db.prepare("DELETE FROM storage_objects WHERE object_key = ?").bind(finalKey),
					db
						.prepare("INSERT INTO storage_objects (object_key, size, etag, uploaded, http_metadata, custom_metadata) VALUES (?, ?, ?, ?, ?, ?)")
						.bind(finalKey, size, newEtag(), nowSeconds(), JSON.stringify(descriptor.httpMetadata ?? {}), JSON.stringify(descriptor.customMetadata ?? {})),
				];
				// Repoint each part's chunks at the final key with a running index offset — the bytes
				// themselves never move, which is what makes the staging-prefix scheme cheap.
				let chunkOffset = 0;
				for (const part of staged) {
					statements.push(db.prepare("UPDATE storage_object_chunks SET object_key = ?, chunk_index = chunk_index + ? WHERE object_key = ?").bind(finalKey, chunkOffset, part.key));
					chunkOffset += Math.ceil(part.size / CHUNK_BYTES);
				}
				// Parts skipped by `parts` are dropped with the rest of the staging subtree.
				statements.push(
					db.prepare("DELETE FROM storage_object_chunks WHERE object_key >= ? AND object_key < ?").bind(marker, upper),
					db.prepare("DELETE FROM storage_objects WHERE object_key >= ? AND object_key < ?").bind(marker, upper),
				);
				await db.batch(statements);
				const object = await this.head(finalKey);
				if (!object) throw new Error("Uploaded object not found");
				return object;
			},
		};
	}
}

export function openDatabaseBucket(env: CloudflareEnv): R2Bucket {
	return new DatabaseBucket(env) as unknown as R2Bucket;
}
