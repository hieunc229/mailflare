import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-vcard-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { v: join(root, "src/lib/contacts/vcard.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { splitVcards, parseVcard, decodeContactPhoto, MAX_VCARDS } = await import(pathToFileURL(join(dir, "v.mjs")).href);

const bytes = (text) => new TextEncoder().encode(text);
const card = (...lines) => ["BEGIN:VCARD", "VERSION:3.0", ...lines, "END:VCARD"].join("\r\n");
const parse = (...lines) => parseVcard(card(...lines));

test("a Google 3.0 card: grouped labels, TYPE lists, PREF, N without FN, ORG with department, BDAY, NOTE, ADR", () => {
	const contact = parse(
		"N:Doe;Jane;Q.;Dr.;",
		"item1.EMAIL;TYPE=INTERNET:work@example.com",
		"item1.X-ABLabel:Work",
		"EMAIL;TYPE=INTERNET,HOME,pref:home@example.com",
		"TEL;TYPE=CELL:+1 555 0100",
		"item2.TEL:+1 555 0101",
		"item2.X-ABLabel:Office",
		"ORG:Acme\\, Inc.;Sales",
		"TITLE:Engineer",
		"BDAY:--0501",
		"NOTE:line one\\nline two\\, with comma",
		"ADR;TYPE=HOME:;;1 Main St;Springfield;IL;62701;USA",
	);
	assert.equal(contact.name, "Jane Q. Doe");
	assert.deepEqual(contact.emails, ["home@example.com", "work@example.com"]);
	assert.deepEqual(contact.details.phones, [{ type: "cell", value: "+1 555 0100" }, { type: "Office", value: "+1 555 0101" }]);
	assert.equal(contact.details.organization, "Acme, Inc., Sales");
	assert.equal(contact.details.title, "Engineer");
	assert.equal(contact.details.birthday, "--05-01");
	assert.equal(contact.details.note, "line one\nline two, with comma");
	assert.deepEqual(contact.details.addresses, [{ type: "home", formatted: "1 Main St, Springfield, IL, 62701, USA" }]);
});

test("FN wins over N, and escaped semicolons stay inside a structured part", () => {
	assert.equal(parse("FN:Jane Doe", "N:Other;Name;;;").name, "Jane Doe");
	assert.equal(parse("N:Smith\u005c;Jones;Ann;;;").name, "Ann Smith;Jones");
});

test("a 4.0 card: tel: URI, quoted TYPE list, birthday forms", () => {
	const contact = parseVcard(["BEGIN:VCARD", "VERSION:4.0", "FN:Al", "TEL;TYPE=\"home,work\";VALUE=uri:tel:+44-20-7946-0000", "EMAIL;PREF=1:al@example.com", "BDAY:19800501", "END:VCARD"].join("\n"));
	assert.deepEqual(contact.details.phones, [{ type: "home, work", value: "+44-20-7946-0000" }]);
	assert.equal(contact.details.birthday, "1980-05-01");
	assert.deepEqual(contact.emails, ["al@example.com"]);
	assert.equal(parse("BDAY:1980-05-01T10:00:00Z").details.birthday, "1980-05-01");
	assert.equal(parse("BDAY:--05-01").details.birthday, "--05-01");
	assert.equal(parse("BDAY:not a date").details.birthday, undefined);
	assert.equal(parse("BDAY:1980-13-45").details.birthday, undefined);
});

test("a 2.1 card: bare TYPE words and quoted-printable with a soft break", () => {
	const contact = parseVcard(["BEGIN:VCARD", "VERSION:2.1", "FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Jos=C3=A9 =", "Garc=C3=ADa", "TEL;WORK;VOICE:555-0102", "EMAIL;INTERNET:jose@example.com", "END:VCARD"].join("\r\n"));
	assert.equal(contact.name, "José García");
	assert.deepEqual(contact.details.phones, [{ type: "work", value: "555-0102" }]);
	assert.deepEqual(contact.emails, ["jose@example.com"]);
});

test("a quoted-printable value never reads past a bounded number of soft breaks", () => {
	const lines = ["BEGIN:VCARD", "NOTE;ENCODING=QUOTED-PRINTABLE:" + "a=", ...Array.from({ length: 500 }, () => "b="), "END:VCARD"];
	const contact = parseVcard(lines.join("\n"));
	assert.ok((contact.details.note ?? "").length <= 100);
});

test("folded lines unfold, including a fold inside a multi-byte character", () => {
	const raw = Buffer.concat([Buffer.from("BEGIN:VCARD\r\nFN:Caf"), Buffer.from([0xc3]), Buffer.from("\r\n "), Buffer.from([0xa9]), Buffer.from("\r\nEMAIL:a@b.co\r\nEND:VCARD\r\n")]);
	const { cards } = splitVcards(raw);
	assert.equal(parseVcard(cards[0].text).name, "Café");
});

test("controls are stripped from stored text and values stay on one line", () => {
	const contact = parse("FN:Eve\u0007\u0000 Mallory", "TEL:555\u001b[31m 0103", "NOTE:ok\u0000bad");
	assert.equal(contact.name, "Eve Mallory");
	assert.equal(contact.details.phones[0].value, "555 [31m 0103");
	assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(JSON.stringify(contact).replace(/\\n/g, "")));
	assert.ok(!/[\u0000-\u001f]/.test(contact.name));
});

test("counts are capped before anything is stored", () => {
	const many = Array.from({ length: 100 }, (_, n) => `EMAIL:e${n}@example.com`);
	assert.ok(parse(...many).emails.length <= 20);
	const phones = Array.from({ length: 100 }, (_, n) => `TEL:555${String(n).padStart(4, "0")}`);
	assert.ok(parse(...phones).details.phones.length <= 20);
	const adrs = Array.from({ length: 100 }, (_, n) => `ADR:;;${n} Road;;;;`);
	assert.ok(parse(...adrs).details.addresses.length <= 10);
	assert.ok(parse(`NOTE:${"x".repeat(100_000)}`).details.note.length <= 4000);
	assert.ok(parse(`ORG:${"o".repeat(5000)}`).details.organization.length <= 200);
});

test("garbage never throws", () => {
	for (const text of ["", "BEGIN:VCARD", "END:VCARD\nBEGIN:VCARD", "::::\n;;;;\n=\n\u0000", "BEGIN:VCARD\nEMAIL:\nTEL:\nN:\nFN:\nEND:VCARD", "x".repeat(200_000)]) {
		const contact = parseVcard(text);
		assert.ok(Array.isArray(contact.emails));
	}
});

test("a long hostile line parses in linear time", () => {
	const started = performance.now();
	parseVcard(card(`TEL;${"A=\"".repeat(15_000)}:1`, `NOTE:${"\\".repeat(60_000)}`, `EMAIL:${"<".repeat(60_000)}`));
	assert.ok(performance.now() - started < 1000);
});

test("a TEL line with 30k repeated parameters parses fast and keeps at most 20 values", () => {
	const started = performance.now();
	const contact = parse(`TEL${";a".repeat(30_000)}:+1 555 0100`);
	assert.ok(performance.now() - started < 100, `took ${performance.now() - started} ms`);
	assert.equal(contact.details.phones[0].value, "+1 555 0100");
	assert.equal(contact.details.phones[0].type, Array.from({ length: 20 }, () => "a").join(", ").slice(0, 32));
});

test("a 1 MiB body of parameter-heavy lines stays fast, in the browser split and the server parse", () => {
	const line = `TEL${";TYPE=a,b".repeat(6_000)}:+1 555 0100`;
	const text = card(...Array.from({ length: Math.ceil((1024 * 1024) / line.length) }, () => line));
	const started = performance.now();
	parseVcard(text);
	splitVcards(bytes(text));
	assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms`);
});

test("parameters after the 64th segment are ignored but the value is still found", () => {
	const contact = parse(`EMAIL${";x=1".repeat(100)};PREF:late@example.com`, `EMAIL;PREF:first@example.com`);
	assert.deepEqual(contact.emails, ["first@example.com", "late@example.com"]);
});

test("quoted-printable soft breaks join in one pass and stay bounded", () => {
	const chunkText = "a".repeat(60_000);
	const lines = ["BEGIN:VCARD", `NOTE;ENCODING=QUOTED-PRINTABLE:${chunkText}=`, ...Array.from({ length: 80 }, () => `${chunkText}=`), "END:VCARD"];
	const started = performance.now();
	const contact = parseVcard(lines.join("\n"));
	assert.ok(performance.now() - started < 100, `took ${performance.now() - started} ms`);
	assert.ok((contact.details.note ?? "").length > 0);
});

test("splitVcards: PHOTO, LOGO, SOUND and KEY lines are removed and the photo is reported, never fetched", () => {
	const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
	const text = [
		card("FN:A", `PHOTO;ENCODING=b;TYPE=JPEG:${b64.slice(0, 4)}\r\n ${b64.slice(4)}`, "LOGO;ENCODING=b:AAAA", "KEY:xxxx", "EMAIL:a@b.co"),
		card("FN:B", "PHOTO;VALUE=uri:https://lh3.googleusercontent.com/x", "EMAIL:b@b.co"),
		card("FN:C", `PHOTO:data:image/png;base64,${b64}`, "EMAIL:c@b.co"),
		card("FN:D", "PHOTO;ENCODING=BASE64;JPEG:" + b64, "EMAIL:d@b.co"),
	].join("\r\n");
	const { cards } = splitVcards(bytes(text));
	assert.equal(cards.length, 4);
	for (const item of cards) assert.ok(!/PHOTO|LOGO|KEY:/i.test(item.text));
	assert.deepEqual(cards[0].photo, { kind: "inline", base64: b64 });
	assert.deepEqual(cards[1].photo, { kind: "uri" });
	assert.deepEqual(cards[2].photo, { kind: "inline", base64: b64 });
	assert.deepEqual(cards[3].photo, { kind: "inline", base64: b64 });
	assert.deepEqual([...decodeContactPhoto(cards[0].photo).bytes], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
	assert.equal(decodeContactPhoto(cards[0].photo).mime, "image/jpeg");
	assert.equal(decodeContactPhoto(cards[1].photo), null);
	assert.equal(parseVcard(cards[0].text).emails[0], "a@b.co");
});

test("decodeContactPhoto sniffs the image type and refuses SVG, scripts, bad base64 and oversize data", () => {
	const inline = (buffer) => ({ kind: "inline", base64: Buffer.from(buffer).toString("base64") });
	assert.equal(decodeContactPhoto(inline([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])).mime, "image/png");
	assert.equal(decodeContactPhoto(inline(Buffer.from("GIF89a....."))).mime, "image/gif");
	assert.equal(decodeContactPhoto(inline(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]))).mime, "image/webp");
	assert.equal(decodeContactPhoto(inline(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))), null);
	assert.equal(decodeContactPhoto(inline(Buffer.from("<html>"))), null);
	assert.equal(decodeContactPhoto({ kind: "inline", base64: "!!!not base64!!!" }), null);
	assert.equal(decodeContactPhoto({ kind: "inline", base64: "" }), null);
	const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(11 * 1024 * 1024)]);
	assert.equal(decodeContactPhoto(inline(big)), null);
});

test("splitVcards: an over-long photo line is dropped as truncated, not decoded", () => {
	const text = card("FN:A", `PHOTO;ENCODING=b:${"A".repeat(300)}`, "EMAIL:a@b.co");
	const { cards } = splitVcards(bytes(text), 200);
	assert.equal(cards[0].photo, null);
	assert.equal(parseVcard(cards[0].text).emails[0], "a@b.co");
});

test("splitVcards: case-insensitive markers, a missing END, nested garbage, size and count caps", () => {
	const text = "begin:vcard\nFN:A\nEMAIL:a@b.co\nend:vcard\nBEGIN:VCARD\nFN:B\nEMAIL:b@b.co\nBEGIN:VCARD\nFN:C\nEMAIL:c@b.co\nEND:VCARD\n";
	assert.deepEqual(splitVcards(bytes(text)).cards.map((item) => parseVcard(item.text).name), ["A", "B", "C"]);
	const huge = card("FN:H", ...Array.from({ length: 4000 }, (_, n) => `NOTE:${"y".repeat(60)}${n}`));
	const result = splitVcards(bytes(huge + "\n" + card("FN:ok", "EMAIL:o@b.co")));
	assert.equal(result.tooLarge, 1);
	assert.equal(result.cards.length, 1);
	assert.equal(typeof MAX_VCARDS, "number");
	const many = Array.from({ length: 12 }, () => card("EMAIL:x@y.zz")).join("\n");
	const limited = splitVcards(bytes(many), undefined, 5);
	assert.equal(limited.cards.length, 5);
	assert.equal(limited.truncated, true);
});

test("a UTF-8 BOM at the start of the file does not hide the first card", () => {
	const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(card("FN:A", "EMAIL:a@b.co"))]);
	assert.equal(splitVcards(raw).cards.length, 1);
});
