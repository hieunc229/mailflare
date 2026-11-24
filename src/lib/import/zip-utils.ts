/**
 * Reads entries from a zip file held as a Blob (a File picked in the browser) without loading it: only the
 * central directory and the requested entry are read, and deflated entries are inflated as a stream. Supports
 * Zip64, which Google Takeout uses for archives over 4 GB.
 */
import type { ZipEntry } from "./zip-types";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 22 + 0xffff;
/** A hostile archive can claim a huge directory; the tab reads it whole, so it is capped. */
export const MAX_ZIP_DIRECTORY_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 500_000;

async function readView(blob: Blob, start: number, end: number): Promise<DataView> {
	return new DataView(await blob.slice(start, end).arrayBuffer());
}

function readUint64(view: DataView, offset: number): number {
	const value = view.getBigUint64(offset, true);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Zip file is too large");
	return Number(value);
}

export function isZipSupported(): boolean {
	return typeof DecompressionStream !== "undefined";
}

export async function listZipEntries(blob: Blob): Promise<ZipEntry[]> {
	const tailStart = Math.max(0, blob.size - MAX_EOCD_SEARCH);
	const tail = await readView(blob, tailStart, blob.size);
	let eocd = -1;
	for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
		if (tail.getUint32(offset, true) === EOCD_SIGNATURE) {
			eocd = offset;
			break;
		}
	}
	if (eocd === -1) throw new Error("Not a zip file");

	let count = tail.getUint16(eocd + 10, true);
	let directorySize = tail.getUint32(eocd + 12, true);
	let directoryOffset = tail.getUint32(eocd + 16, true);
	if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
		const locator = eocd - 20;
		if (locator < 0 || tail.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) throw new Error("Invalid Zip64 file");
		const recordOffset = readUint64(tail, locator + 8);
		const record = await readView(blob, recordOffset, recordOffset + 56);
		if (record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) throw new Error("Invalid Zip64 file");
		count = readUint64(record, 32);
		directorySize = readUint64(record, 40);
		directoryOffset = readUint64(record, 48);
	}

	if (count > MAX_ZIP_ENTRIES || directorySize > MAX_ZIP_DIRECTORY_BYTES) throw new Error("Not a supported zip file");
	const directory = await readView(blob, directoryOffset, directoryOffset + directorySize);
	const decoder = new TextDecoder();
	const entries: ZipEntry[] = [];
	let offset = 0;
	for (let index = 0; index < count && offset + 46 <= directory.byteLength; index += 1) {
		if (directory.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new Error("Corrupt zip directory");
		const madeBy = directory.getUint16(offset + 4, true);
		const flags = directory.getUint16(offset + 8, true);
		const method = directory.getUint16(offset + 10, true);
		let compressedSize = directory.getUint32(offset + 20, true);
		let size = directory.getUint32(offset + 24, true);
		const nameLength = directory.getUint16(offset + 28, true);
		const extraLength = directory.getUint16(offset + 30, true);
		const commentLength = directory.getUint16(offset + 32, true);
		let localHeaderOffset = directory.getUint32(offset + 42, true);
		// Unix zips (host 3) keep st_mode in the high half of the external attributes; 0o120000 is a symbolic link.
		const isSymlink = madeBy >> 8 === 3 && ((directory.getUint32(offset + 38, true) >>> 16) & 0xf000) === 0xa000;
		const nameStart = directory.byteOffset + offset + 46;
		const name = decoder.decode(new Uint8Array(directory.buffer, nameStart, nameLength));

		let extra = offset + 46 + nameLength;
		const extraEnd = extra + extraLength;
		while (extra + 4 <= extraEnd) {
			const id = directory.getUint16(extra, true);
			const length = directory.getUint16(extra + 2, true);
			if (id === 0x0001) {
				let field = extra + 4;
				if (size === 0xffffffff) { size = readUint64(directory, field); field += 8; }
				if (compressedSize === 0xffffffff) { compressedSize = readUint64(directory, field); field += 8; }
				if (localHeaderOffset === 0xffffffff) localHeaderOffset = readUint64(directory, field);
			}
			extra += 4 + length;
		}

		entries.push({ name, method, compressedSize, size, localHeaderOffset, encrypted: (flags & 1) === 1, isSymlink });
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** Streams the uncompressed bytes of one entry. */
/**
 * Splits whatever chunking a stream has into slices of at most `size` bytes. Fed to a decompressor, it bounds how
 * much output one write can produce, so a byte counter on the output works the same on every runtime.
 */
export function sliceChunks(size: number): TransformStream<Uint8Array, Uint8Array> {
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			for (let offset = 0; offset < chunk.length; offset += size) controller.enqueue(chunk.subarray(offset, offset + size));
		},
	});
}

/** `maxInputBytes` re-slices the compressed bytes before they reach the inflater (see `sliceChunks`). */
export async function openZipEntry(blob: Blob, entry: ZipEntry, options: { maxInputBytes?: number } = {}): Promise<ReadableStream<Uint8Array>> {
	if (entry.encrypted) throw new Error(`${entry.name} is encrypted`);
	if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} uses an unsupported compression method`);
	const header = await readView(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30);
	if (header.getUint32(0, true) !== LOCAL_SIGNATURE) throw new Error("Corrupt zip entry");
	const start = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
	const data = blob.slice(start, start + entry.compressedSize).stream() as ReadableStream<Uint8Array>;
	if (entry.method === 0) return data;
	const input = options.maxInputBytes ? data.pipeThrough(sliceChunks(options.maxInputBytes)) : data;
	return input.pipeThrough(new DecompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

/** Iterates a ReadableStream; Safari has no async iteration for streams. */
export async function* readStreamChunks(stream: ReadableStream<Uint8Array>, onBytes?: (bytes: number) => void): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			onBytes?.(value.length);
			yield value;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/**
 * Reads a whole entry into memory. It refuses a declared size over `maxBytes`, and stops as soon as the inflated bytes
 * pass the declared size, so a header that lies about a decompression bomb cannot make the tab inflate it.
 */
export async function readZipEntryBytes(blob: Blob, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
	if (entry.size > maxBytes) throw new Error(`${entry.name} is too large`);
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of readStreamChunks(await openZipEntry(blob, entry))) {
		total += chunk.length;
		if (total > entry.size) throw new Error(`${entry.name} is larger than its header says`);
		chunks.push(chunk);
	}
	if (total !== entry.size) throw new Error(`${entry.name} is corrupt`);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	return bytes;
}
