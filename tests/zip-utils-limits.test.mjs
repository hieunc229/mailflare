import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { listZipEntries, MAX_ZIP_DIRECTORY_BYTES, MAX_ZIP_ENTRIES, readZipEntryBytes } from "../src/lib/import/zip-utils.ts";

/** `declared` lets a test lie about the uncompressed size; `mode` sets a unix mode in the external attributes. */
function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data, method = 8, declared, mode } of entries) {
		const nameBytes = Buffer.from(name);
		const payload = method === 8 ? deflateRawSync(data) : data;
		const size = declared ?? data.length;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, payload);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		if (mode !== undefined) {
			central.writeUInt16LE(0x0314, 4);
			central.writeUInt32LE((mode << 16) >>> 0, 38);
		}
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(size, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + payload.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Blob([...locals, directory, end]);
}

test("symlink entries are flagged from the unix mode", async () => {
	const zip = buildZip([
		{ name: "a.ics", data: Buffer.from("x"), mode: 0o100644 },
		{ name: "link.ics", data: Buffer.from("/etc/passwd"), mode: 0o120777 },
		{ name: "plain.ics", data: Buffer.from("x") },
	]);
	assert.deepEqual((await listZipEntries(zip)).map((entry) => entry.isSymlink), [false, true, false]);
});

test("a central directory over the cap is refused before it is read", async () => {
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(MAX_ZIP_DIRECTORY_BYTES + 1, 12);
	await assert.rejects(() => listZipEntries(new Blob([end])), /Not a supported zip file/);
});

test("an entry count over the cap is refused (Zip64 record)", async () => {
	const record = Buffer.alloc(56);
	record.writeUInt32LE(0x06064b50, 0);
	record.writeBigUInt64LE(BigInt(MAX_ZIP_ENTRIES + 1), 32);
	record.writeBigUInt64LE(46n, 40);
	record.writeBigUInt64LE(0n, 48);
	const locator = Buffer.alloc(20);
	locator.writeUInt32LE(0x07064b50, 0);
	locator.writeBigUInt64LE(0n, 8);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0xffff, 10);
	end.writeUInt32LE(0xffffffff, 12);
	end.writeUInt32LE(0xffffffff, 16);
	await assert.rejects(() => listZipEntries(new Blob([record, locator, end])), /Not a supported zip file/);
});

test("readZipEntryBytes returns deflated and stored entries", async () => {
	const zip = buildZip([{ name: "d.ics", data: Buffer.from("BEGIN:VCALENDAR"), method: 8 }, { name: "s.ics", data: Buffer.from("stored"), method: 0 }]);
	const [deflated, stored] = await listZipEntries(zip);
	assert.equal(Buffer.from(await readZipEntryBytes(zip, deflated, 1024)).toString(), "BEGIN:VCALENDAR");
	assert.equal(Buffer.from(await readZipEntryBytes(zip, stored, 1024)).toString(), "stored");
});

test("readZipEntryBytes refuses a declared size over the limit", async () => {
	const zip = buildZip([{ name: "big.ics", data: Buffer.alloc(2000, 97) }]);
	const [entry] = await listZipEntries(zip);
	await assert.rejects(() => readZipEntryBytes(zip, entry, 1000), /too large/);
});

test("readZipEntryBytes stops when the data inflates past the declared size", async () => {
	// The header says 10 bytes; the deflate stream yields 1 MB.
	const zip = buildZip([{ name: "bomb.ics", data: Buffer.alloc(1_000_000, 97), declared: 10 }]);
	const [entry] = await listZipEntries(zip);
	assert.equal(entry.size, 10);
	await assert.rejects(() => readZipEntryBytes(zip, entry, 1024), /larger than/);
});

test("readZipEntryBytes rejects data shorter than declared", async () => {
	const zip = buildZip([{ name: "short.ics", data: Buffer.from("abc"), declared: 50 }]);
	const [entry] = await listZipEntries(zip);
	await assert.rejects(() => readZipEntryBytes(zip, entry, 1024), /corrupt/i);
});
