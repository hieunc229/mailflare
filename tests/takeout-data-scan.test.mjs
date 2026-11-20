import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-takeout-scan-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { t: join(root, "src/lib/import/takeout-data-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { scanTakeoutData, readTakeoutSource, MAX_TEXT_SOURCE_BYTES, MAX_DRIVE_FILES } = await import(pathToFileURL(join(dir, "t.mjs")).href);

function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data, method = 8, declared, mode } of entries) {
		const crc = crc32(data);
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
		if (mode !== undefined) { central.writeUInt16LE(0x0314, 4); central.writeUInt32LE((mode << 16) >>> 0, 38); }
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
	const scan = await scanTakeoutData([file("takeout-001.zip", zip), file("Direct.ics", ics), file("notes.txt", "x"), file("notazip.zip", "nope")]);
	assert.deepEqual(scan.calendars.map((source) => source.label).sort(), ["Direct", "Work", "a@gmail.com", "evil"]);
	assert.deepEqual(scan.ignored, ["notes.txt"]);
	assert.deepEqual(scan.unreadable, ["notazip.zip"]);
	assert.equal(new Set(scan.calendars.map((source) => source.id)).size, 4);
});

test("oversized sources are reported and not offered", async () => {
	const zip = buildZip([{ name: "Takeout/Calendar/big.ics", data: Buffer.from("x"), declared: MAX_TEXT_SOURCE_BYTES + 1 }]);
	const scan = await scanTakeoutData([file("t.zip", zip)]);
	assert.deepEqual(scan.calendars, []);
	assert.deepEqual(scan.tooLarge, ["big.ics"]);
});

test("a source reads back its bytes from a zip entry and from a plain file", async () => {
	const zip = buildZip([{ name: "Takeout/Calendar/a.ics", data: Buffer.from(ics) }]);
	const scan = await scanTakeoutData([file("t.zip", zip), file("b.ics", ics)]);
	for (const source of scan.calendars) assert.equal(Buffer.from(await readTakeoutSource(source)).toString(), ics);
});

const HEADER = "First Name,Last Name,E-mail 1 - Label,E-mail 1 - Value\r\n";
const vcf = "BEGIN:VCARD\r\nFN:A\r\nEMAIL:a@b.co\r\nEND:VCARD\r\n";

test("contacts are found by extension and, for CSV, by the Google header", async () => {
	const zip = buildZip([
		{ name: "Takeout/Kontakte/Alle Kontakte/Alle Kontakte.vcf", data: Buffer.from(vcf) },
		{ name: "Takeout/Contacts/Friends/Friends.VCF", data: Buffer.from(vcf) },
		{ name: "Takeout/Contacts/contacts.csv", data: Buffer.from(HEADER + "A,B,Home,a@b.co\r\n") },
		{ name: "Takeout/Contacts/legacy.csv", data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Name,E-mail 1 - Value\r\n", "utf16le")]), method: 0 },
		{ name: "Takeout/Drive/budget.csv", data: Buffer.from("date,amount\r\n1,2\r\n") },
		{ name: "Takeout/Contacts/.hidden.vcf", data: Buffer.from(vcf) },
		{ name: "Takeout/Contacts/link.vcf", data: Buffer.from("/etc/passwd"), mode: 0o120777 },
		{ name: "Takeout/Calendar/a.ics", data: Buffer.from(ics) },
	]);
	const scan = await scanTakeoutData([file("t.zip", zip), file("Direct.vcf", vcf), file("people.csv", HEADER), file("budget.csv", "date,amount\n"), file("notes.txt", "x")]);
	assert.deepEqual(scan.contacts.map((source) => [source.label, source.kind]).sort(), [["Alle Kontakte", "vcard"], ["Direct", "vcard"], ["Friends", "vcard"], ["contacts", "csv"], ["legacy", "csv"], ["people", "csv"]]);
	assert.equal(new Set(scan.contacts.map((source) => source.id)).size, 6);
	assert.deepEqual(scan.calendars.map((source) => source.label), ["a"]);
	assert.deepEqual(scan.ignored.sort(), ["budget.csv", "notes.txt"]);
});

test("an oversized contacts file is reported and not offered", async () => {
	const zip = buildZip([{ name: "Takeout/Contacts/big.vcf", data: Buffer.from("x"), declared: MAX_TEXT_SOURCE_BYTES + 1 }]);
	const scan = await scanTakeoutData([file("t.zip", zip)]);
	assert.deepEqual(scan.contacts, []);
	assert.deepEqual(scan.tooLarge, ["big.vcf"]);
});

test("a CSV whose header cannot be read is skipped without failing the scan", async () => {
	const zip = buildZip([{ name: "Takeout/Contacts/odd.csv", data: Buffer.from("x"), method: 99 }, { name: "Takeout/Contacts/ok.vcf", data: Buffer.from(vcf) }]);
	const scan = await scanTakeoutData([file("t.zip", zip)]);
	assert.deepEqual(scan.contacts.map((source) => source.label), ["ok"]);
});

test("a contacts source reads back its bytes from a zip entry and from a plain file", async () => {
	const zip = buildZip([{ name: "Takeout/Contacts/a.vcf", data: Buffer.from(vcf) }]);
	const scan = await scanTakeoutData([file("t.zip", zip), file("b.vcf", vcf)]);
	assert.equal(scan.contacts.length, 2);
	for (const source of scan.contacts) assert.equal(Buffer.from(await readTakeoutSource(source)).toString(), vcf);
});

const driveZip = () => buildZip([
	{ name: "Takeout/Drive/x/y.txt", data: Buffer.from("hello") },
	{ name: "Takeout/Drive/Résumé.docx", data: Buffer.from("doc"), method: 0 },
	{ name: "Takeout/Drive/empty/", data: Buffer.alloc(0), method: 0 },
	{ name: "Takeout/Drive/shared/notes.ics", data: Buffer.from(ics) },
	{ name: "Takeout/Drive/shared/people.vcf", data: Buffer.from(vcf) },
	{ name: "Takeout/Drive/shared/.DS_Store", data: Buffer.from("x") },
	{ name: "__MACOSX/Takeout/Drive/._y.txt", data: Buffer.from("x") },
	{ name: "Takeout/Drive/link.txt", data: Buffer.from("/etc/passwd"), mode: 0o120777 },
	{ name: "Takeout/Drive/../evil.txt", data: Buffer.from("x") },
	{ name: "Takeout/Drive/a\u0001b.txt", data: Buffer.from("x") },
	{ name: "Takeout/Kalender/a@gmail.com.ics", data: Buffer.from(ics) },
	{ name: "Takeout/Mail/All mail.mbox", data: Buffer.from("From x") },
	{ name: "Takeout/My Activity/Search/MyActivity.html", data: Buffer.from("<html>") },
	{ name: "Takeout/My Activity/Search/MyActivity.json", data: Buffer.from("{}") },
	{ name: "Takeout/archive_browser.html", data: Buffer.from("x"), method: 0 },
]);

test("Drive files are every regular entry under the Drive folder, with their path, size and CRC", async () => {
	const scan = await scanTakeoutData([file("t.zip", driveZip())]);
	const drive = scan.drive.files.filter((entry) => entry.rootKey === "Takeout/Drive");
	assert.deepEqual(drive.map((entry) => entry.segments.join("/")).sort(), ["Résumé.docx", "ab.txt", "shared/notes.ics", "shared/people.vcf", "x/y.txt"]);
	const text = drive.find((entry) => entry.name === "y.txt");
	assert.equal(text.size, 5);
	assert.equal(text.crc32, crc32(Buffer.from("hello")));
	assert.deepEqual(scan.drive.dirs.map((dir) => dir.segments.join("/")), ["empty"]);
	assert.equal(scan.drive.skipped.symlinks, 1);
	// A control character is stripped from a name, not a reason to refuse the file.
	assert.equal(scan.drive.rejected.length, 1);
	assert.equal(scan.drive.rejectedCount, 1);
	assert.match(scan.drive.rejected.map((item) => item.name).join(), /evil\.txt/);
});

test("a calendar or contacts file inside the Drive folder is a Drive file, not an import source", async () => {
	const scan = await scanTakeoutData([file("t.zip", driveZip())]);
	assert.deepEqual(scan.calendars.map((source) => source.label), ["a@gmail.com"]);
	assert.deepEqual(scan.contacts, []);
});

test("other product folders are offered as roots, minus mail and JSON sidecars and anything already a source", async () => {
	const scan = await scanTakeoutData([file("t.zip", driveZip())]);
	assert.deepEqual(scan.drive.roots.map((root) => [root.key, root.label, root.files]).sort(), [["Takeout/Drive", "Drive", 5], ["Takeout/My Activity", "My Activity", 1]]);
	assert.equal(scan.drive.roots.find((root) => root.label === "Drive").bytes, 5 + 3 + 1 + ics.length + vcf.length);
});

test("a zip without the Takeout folder uses its first folder as the root, and plain files never become Drive files", async () => {
	const zip = buildZip([{ name: "Drive/a.txt", data: Buffer.from("a") }, { name: "top.txt", data: Buffer.from("t") }]);
	const scan = await scanTakeoutData([file("t.zip", zip), file("loose.txt", "x")]);
	assert.deepEqual(scan.drive.roots.map((root) => root.key), ["Drive"]);
	assert.deepEqual(scan.drive.files.map((entry) => entry.segments), [["a.txt"]]);
	assert.deepEqual(scan.ignored, ["loose.txt"]);
});

test("the cap is per product folder: one folder cut short does not block another", async () => {
	const zip = buildZip([
		...Array.from({ length: 5 }, (_, index) => ({ name: `Takeout/Drive/f${index}.txt`, data: Buffer.from("x") })),
		...Array.from({ length: 2 }, (_, index) => ({ name: `Takeout/Photos/p${index}.jpg`, data: Buffer.from("x") })),
		...Array.from({ length: 5 }, (_, index) => ({ name: `Takeout/Drive/d${index}/`, data: Buffer.alloc(0), method: 0 })),
	]);
	const scan = await scanTakeoutData([file("t.zip", zip)], { maxDriveFiles: 3 });
	const root = (label) => scan.drive.roots.find((entry) => entry.label === label);
	assert.deepEqual([root("Drive").files, root("Drive").tooMany], [3, true]);
	assert.deepEqual([root("Photos").files, root("Photos").tooMany], [2, false]);
	assert.equal(scan.drive.files.filter((entry) => entry.rootKey === "Takeout/Photos").length, 2);
	assert.equal(scan.drive.dirs.length, 3);
	const all = await scanTakeoutData([file("t.zip", zip)]);
	assert.deepEqual(all.drive.roots.map((entry) => entry.tooMany), [false, false]);
	assert.ok(MAX_DRIVE_FILES >= 100_000);
});
