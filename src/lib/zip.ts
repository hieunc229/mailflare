/**
 * Minimal streaming ZIP writer: STORED entries (the payloads, e.g. attachments, are already
 * compressed), CRC32 and sizes carried in data descriptors so nothing has to be buffered, and
 * a central directory at the end. `createZipStream` pulls one entry at a time and yields one
 * chunk per `pull`, so memory stays bounded regardless of archive size.
 */
export type ZipEntrySource = {
	/** Name inside the archive. Slashes keep working as folder separators; backslashes are replaced. */
	name: string;
	/** When the stored file was last modified; defaults to now. */
	modified?: Date;
	/** Opens the entry body. Return null to skip the entry (e.g. the object went missing). */
	open: () => Promise<ReadableStream<Uint8Array> | null> | ReadableStream<Uint8Array> | null;
};

type ZipCentralEntry = {
	name: Uint8Array;
	crc: number;
	size: number;
	offset: number;
	flags: number;
	dosTime: number;
	dosDate: number;
};

// Data descriptor (sizes known only after streaming) plus UTF-8 names.
const ENTRY_FLAGS = 0x0008 | 0x0800;
const VERSION_NEEDED = 20;
const LOCAL_HEADER_LENGTH = 30;
const DATA_DESCRIPTOR_LENGTH = 16;
const CENTRAL_HEADER_LENGTH = 46;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

/** Standard CRC-32; pass the previous result to keep accumulating across chunks. */
export function crc32(data: Uint8Array, crc = 0): number {
	let c = crc ^ 0xffffffff;
	for (let index = 0; index < data.byteLength; index += 1) c = CRC_TABLE[(c ^ data[index]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
	const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
	const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
	return { dosTime, dosDate };
}

function zipEntryName(name: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = name.replace(/[\u0000-\u001f]/g, "").replace(/\\/g, "_").replace(/^\/+/, "").trim();
	return cleaned || "file";
}

/** Duplicate names make archives ambiguous; later copies get a ` (n)` suffix before the extension. */
export function uniqueZipNames(names: string[]): string[] {
	const taken = new Set<string>();
	return names.map((name) => {
		const cleaned = zipEntryName(name);
		if (!taken.has(cleaned)) {
			taken.add(cleaned);
			return cleaned;
		}
		const dot = cleaned.lastIndexOf(".");
		const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
		const extension = dot > 0 ? cleaned.slice(dot) : "";
		for (let copy = 2; ; copy += 1) {
			const candidate = `${base} (${copy})${extension}`;
			if (!taken.has(candidate)) {
				taken.add(candidate);
				return candidate;
			}
		}
	});
}

async function* generateZip(entries: ZipEntrySource[]): AsyncGenerator<Uint8Array> {
	const encoder = new TextEncoder();
	const names = uniqueZipNames(entries.map((entry) => entry.name));
	const central: ZipCentralEntry[] = [];
	let offset = 0;

	for (let index = 0; index < entries.length; index += 1) {
		const body = await entries[index].open();
		if (!body) continue;
		const name = encoder.encode(names[index]);
		const { dosTime, dosDate } = toDosDateTime(entries[index].modified ?? new Date());

		const local = new DataView(new ArrayBuffer(LOCAL_HEADER_LENGTH));
		local.setUint32(0, 0x04034b50, true); // local file header signature
		local.setUint16(4, VERSION_NEEDED, true);
		local.setUint16(6, ENTRY_FLAGS, true);
		local.setUint16(8, 0, true); // method: stored
		local.setUint16(10, dosTime, true);
		local.setUint16(12, dosDate, true);
		// CRC-32 and both sizes stay zero here; the data descriptor after the data carries them.
		local.setUint16(26, name.byteLength, true);
		yield new Uint8Array(local.buffer);
		yield name;

		let crc = 0;
		let size = 0;
		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value.byteLength) continue;
				crc = crc32(value, crc);
				size += value.byteLength;
				yield value;
			}
		} finally {
			// Also releases the lock; on a finished body it is a no-op, on early teardown it stops the fetch.
			await reader.cancel().catch(() => undefined);
		}

		const descriptor = new DataView(new ArrayBuffer(DATA_DESCRIPTOR_LENGTH));
		descriptor.setUint32(0, 0x08074b50, true); // data descriptor signature
		descriptor.setUint32(4, crc, true);
		descriptor.setUint32(8, size, true); // compressed size
		descriptor.setUint32(12, size, true); // uncompressed size
		yield new Uint8Array(descriptor.buffer);

		central.push({ name, crc, size, offset, flags: ENTRY_FLAGS, dosTime, dosDate });
		offset += LOCAL_HEADER_LENGTH + name.byteLength + size + DATA_DESCRIPTOR_LENGTH;
	}

	const directoryOffset = offset;
	for (const entry of central) {
		const header = new DataView(new ArrayBuffer(CENTRAL_HEADER_LENGTH));
		header.setUint32(0, 0x02014b50, true); // central directory header signature
		header.setUint16(4, VERSION_NEEDED, true); // version made by
		header.setUint16(6, VERSION_NEEDED, true);
		header.setUint16(8, entry.flags, true);
		header.setUint16(10, 0, true); // method: stored
		header.setUint16(12, entry.dosTime, true);
		header.setUint16(14, entry.dosDate, true);
		header.setUint32(16, entry.crc, true);
		header.setUint32(20, entry.size, true);
		header.setUint32(24, entry.size, true);
		header.setUint16(28, entry.name.byteLength, true);
		header.setUint32(42, entry.offset, true); // offset of the local header
		yield new Uint8Array(header.buffer);
		yield entry.name;
		offset += CENTRAL_HEADER_LENGTH + entry.name.byteLength;
	}

	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true); // end of central directory signature
	end.setUint16(8, central.length, true);
	end.setUint16(10, central.length, true);
	end.setUint32(12, offset - directoryOffset, true); // central directory size
	end.setUint32(16, directoryOffset, true);
	yield new Uint8Array(end.buffer);
}

/**
 * Streams `entries` into a ZIP archive. `pull` drives the generator, so only one entry and one
 * chunk are in flight at a time. An entry whose `open` returns null is left out of the archive.
 */
export function createZipStream(entries: ZipEntrySource[]): ReadableStream<Uint8Array> {
	const iterator = generateZip(entries)[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await iterator.return?.(undefined).catch(() => undefined);
		},
	});
}
