import assert from "node:assert/strict";
import test from "node:test";
import { crc32 as nodeCrc32, deflateRawSync } from "node:zlib";

import { crc32, createZipPartReader, listZipEntries, MAX_ZIP_DIRECTORY_BYTES, MAX_ZIP_ENTRIES, readZipEntryBytes } from "../src/lib/import/zip-utils.ts";

/** `declared` lets a test lie about the uncompressed size; `mode` sets a unix mode in the external attributes. */
function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data, method = 8, declared, mode, crc = nodeCrc32(data) } of entries) {
		const nameBytes = Buffer.from(name);
		const payload = method === 8 ? deflateRawSync(data) : data;
		const size = declared ?? data.length;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
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
		central.writeUInt32LE(crc, 16);
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

test("crc32 matches the standard check value and can be continued", () => {
	assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
	assert.equal(crc32(new Uint8Array(0)), 0);
	const a = new TextEncoder().encode("1234");
	const b = new TextEncoder().encode("56789");
	assert.equal(crc32(b, crc32(a)), 0xcbf43926);
});

test("listZipEntries reads the CRC-32 of each entry", async () => {
	const zip = buildZip([{ name: "a.txt", data: Buffer.from("hello") }]);
	const [entry] = await listZipEntries(zip);
	assert.equal(entry.crc32, nodeCrc32(Buffer.from("hello")));
});

test("readZipEntryBytes rejects data whose CRC-32 differs from the directory", async () => {
	const zip = buildZip([{ name: "a.ics", data: Buffer.from("hello"), crc: 1234 }]);
	const [entry] = await listZipEntries(zip);
	await assert.rejects(() => readZipEntryBytes(zip, entry, 1024), /corrupt/i);
});

for (const method of [0, 8]) {
	test(`the part reader returns parts in order and verifies the entry (method ${method})`, async () => {
		const zip = buildZip([{ name: "f.bin", data: Buffer.from("0123456789"), method }]);
		const [entry] = await listZipEntries(zip);
		const reader = createZipPartReader(zip, entry);
		assert.equal(await (await reader.readPart(0, 4)).text(), "0123");
		assert.equal(await (await reader.readPart(1, 4)).text(), "4567");
		assert.equal(await (await reader.readPart(2, 4)).text(), "89");
		await reader.verify();
	});

	test(`the part reader can skip stored parts and still verifies the skipped bytes (method ${method})`, async () => {
		const zip = buildZip([{ name: "f.bin", data: Buffer.from("0123456789"), method }]);
		const [entry] = await listZipEntries(zip);
		const reader = createZipPartReader(zip, entry);
		assert.equal(await (await reader.readPart(2, 4)).text(), "89");
		await reader.verify();
		const bad = buildZip([{ name: "f.bin", data: Buffer.from("0123456789"), method, crc: 7 }]);
		const [badEntry] = await listZipEntries(bad);
		const badReader = createZipPartReader(bad, badEntry);
		await badReader.readPart(2, 4);
		await assert.rejects(() => badReader.verify(), /corrupt/i);
	});
}

test("the part reader refuses to go back and stops at an inflated overrun", async () => {
	const zip = buildZip([{ name: "f.bin", data: Buffer.from("0123456789") }]);
	const [entry] = await listZipEntries(zip);
	const reader = createZipPartReader(zip, entry);
	await reader.readPart(1, 4);
	await assert.rejects(() => reader.readPart(0, 4), /order/);
	const bomb = buildZip([{ name: "b.bin", data: Buffer.alloc(1_000_000, 97), declared: 10 }]);
	const [bombEntry] = await listZipEntries(bomb);
	const bombReader = createZipPartReader(bomb, bombEntry);
	assert.equal((await bombReader.readPart(0, 64)).size, 10);
	await assert.rejects(() => bombReader.verify(), /larger than/);
	const bombVerify = createZipPartReader(bomb, bombEntry);
	await assert.rejects(() => bombVerify.verify(), /larger than/);
});

test("the part reader rejects data shorter than declared", async () => {
	const zip = buildZip([{ name: "s.bin", data: Buffer.from("abc"), declared: 50 }]);
	const [entry] = await listZipEntries(zip);
	await assert.rejects(() => createZipPartReader(zip, entry).readPart(0, 64), /corrupt/i);
	await assert.rejects(() => createZipPartReader(zip, entry).verify(), /corrupt/i);
});
