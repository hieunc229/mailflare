import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-takeout-scan-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { t: join(root, "src/lib/import/takeout-data-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { scanTakeoutCalendars, readCalendarSource, MAX_TEXT_SOURCE_BYTES } = await import(pathToFileURL(join(dir, "t.mjs")).href);

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
		if (mode !== undefined) { central.writeUInt16LE(0x0314, 4); central.writeUInt32LE((mode << 16) >>> 0, 38); }
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
	return Buffer.concat([...locals, directory, end]);
}

const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
const file = (name, data) => new File([data], name);

test("calendars are found by extension, whatever the folder is called", async () => {
	const zip = buildZip([
		{ name: "Takeout/Kalender/a@gmail.com.ics", data: Buffer.from(ics) },
		{ name: "Takeout/Calendar/Work.ICS", data: Buffer.from(ics) },
		{ name: "Takeout/Contacts/All Contacts/All Contacts.vcf", data: Buffer.from("x") },
		{ name: "Takeout/Drive/x/y.txt", data: Buffer.from("x") },
		{ name: "Takeout/archive_browser.html", data: Buffer.from("x"), method: 0 },
		{ name: "Takeout/Calendar/empty/", data: Buffer.alloc(0), method: 0 },
		{ name: "__MACOSX/Takeout/Calendar/._Work.ics", data: Buffer.from("x") },
		{ name: "Takeout/Calendar/.hidden.ics", data: Buffer.from("x") },
		{ name: "Takeout/Calendar/link.ics", data: Buffer.from("/etc/passwd"), mode: 0o120777 },
		{ name: "../evil.ics", data: Buffer.from(ics) },
	]);
	const scan = await scanTakeoutCalendars([file("takeout-001.zip", zip), file("Direct.ics", ics), file("contacts.vcf", "x"), file("notazip.zip", "nope")]);
	assert.deepEqual(scan.calendars.map((source) => source.label).sort(), ["Direct", "Work", "a@gmail.com", "evil"]);
	assert.deepEqual(scan.ignored, ["contacts.vcf"]);
	assert.deepEqual(scan.unreadable, ["notazip.zip"]);
	assert.equal(new Set(scan.calendars.map((source) => source.id)).size, 4);
});

test("oversized sources are reported and not offered", async () => {
	const zip = buildZip([{ name: "Takeout/Calendar/big.ics", data: Buffer.from("x"), declared: MAX_TEXT_SOURCE_BYTES + 1 }]);
	const scan = await scanTakeoutCalendars([file("t.zip", zip)]);
	assert.deepEqual(scan.calendars, []);
	assert.deepEqual(scan.tooLarge, ["big.ics"]);
});

test("a source reads back its bytes from a zip entry and from a plain file", async () => {
	const zip = buildZip([{ name: "Takeout/Calendar/a.ics", data: Buffer.from(ics) }]);
	const scan = await scanTakeoutCalendars([file("t.zip", zip), file("b.ics", ics)]);
	for (const source of scan.calendars) assert.equal(Buffer.from(await readCalendarSource(source)).toString(), ics);
});
