import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-takeout-contacts-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { r: join(root, "src/lib/import/takeout-contacts-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { importContactsBytes, previewContactsBytes, makeContactBatches } = await import(pathToFileURL(join(dir, "r.mjs")).href);

// Nothing in the importer may fetch a URL from a contacts file.
globalThis.fetch = () => { throw new Error("fetch must not be called"); };

const settings = { mailboxId: "mbx_1", photos: true };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
const vcard = (n, ...extra) => ["BEGIN:VCARD", "VERSION:3.0", `FN:Person ${n}`, `EMAIL:p${n}@example.com`, ...extra, "END:VCARD"].join("\r\n");
const vcf = (count, extra = () => []) => new TextEncoder().encode(Array.from({ length: count }, (_, n) => vcard(n, ...extra(n))).join("\r\n"));
const ok = (created, extra = {}) => ({ status: 200, data: { created, updated: 0, unchanged: 0, noEmail: 0, photoTargets: [], ...extra } });
const run = (post, extra = {}) => ({ post, uploadPhoto: async () => {}, sleep: async () => {}, ...extra });

test("cards go out in bounded batches with the mailbox attached, and the counts add up", async () => {
	const bodies = [];
	const summary = await importContactsBytes(vcf(120), "vcard", settings, run(async (body) => (bodies.push(body), ok(body.items.length))));
	assert.deepEqual(bodies.map((body) => body.items.length), [100, 20]);
	assert.equal(bodies[0].mailboxId, "mbx_1");
	assert.equal(bodies[0].format, "vcard");
	assert.deepEqual(Object.keys(bodies[0].items[0]).sort(), ["hasPhoto", "vcard"]);
	assert.equal(summary.cards, 120);
	assert.equal(summary.created, 120);
	assert.equal(summary.failed, 0);
});

test("batches are also kept under 256 KiB", () => {
	const items = Array.from({ length: 10 }, () => ({ size: 100 * 1024 }));
	assert.deepEqual(makeContactBatches(items).map((batch) => batch.length), [2, 2, 2, 2, 2]);
	assert.deepEqual(makeContactBatches([{ size: 900 * 1024 }, { size: 1 }]).map((batch) => batch.length), [1, 1]);
});

test("cards without a valid address are counted and named, not sent", async () => {
	const text = [vcard(1), "BEGIN:VCARD\r\nFN:No Mail A\r\nEND:VCARD", "BEGIN:VCARD\r\nFN:Bad\r\nEMAIL:nope\r\nEND:VCARD", ...Array.from({ length: 6 }, (_, n) => `BEGIN:VCARD\r\nFN:Extra ${n}\r\nEND:VCARD`)].join("\r\n");
	const bodies = [];
	const summary = await importContactsBytes(new TextEncoder().encode(text), "vcard", settings, run(async (body) => (bodies.push(body), ok(1))));
	assert.equal(bodies[0].items.length, 1);
	assert.equal(summary.withEmail, 1);
	assert.equal(summary.noEmail, 8);
	assert.deepEqual(summary.noEmailNames, ["No Mail A", "Bad", "Extra 0", "Extra 1", "Extra 2"]);
});

test("photos: only the targets the server names are uploaded, from the card's own bytes, and never fetched", async () => {
	const cards = [
		vcard(1, `PHOTO;ENCODING=b;TYPE=JPEG:${JPEG}`),
		vcard(2, `PHOTO;ENCODING=b;TYPE=JPEG:${JPEG}`),
		vcard(3, "PHOTO;VALUE=uri:https://lh3.googleusercontent.com/x"),
		vcard(4, "PHOTO;ENCODING=b:!!!not-base64"),
	];
	const uploads = [];
	const bodies = [];
	const summary = await importContactsBytes(new TextEncoder().encode(cards.join("\r\n")), "vcard", settings, run(async (body) => (bodies.push(body), ok(4, { photoTargets: ["p1@example.com", "p3@example.com", "p4@example.com", "stranger@example.com"] })), {
		uploadPhoto: async (address, file) => { uploads.push([address, file.type, file.size]); },
	}));
	assert.deepEqual(uploads, [["p1@example.com", "image/jpeg", 7]]);
	// A photo that is not valid base64 still counts as inline here; decoding happens only for the targets named.
	assert.deepEqual(bodies[0].items.map((item) => item.hasPhoto), [true, true, false, true]);
	assert.ok(!JSON.stringify(bodies).includes("PHOTO"));
	assert.equal(summary.photosUploaded, 1);
	assert.equal(summary.photosFailed, 1);
	assert.deepEqual(summary.errors, [{ key: "importPage.takeoutDataPhotoUnsupported" }]);
});

test("a photo that cannot be uploaded is counted and reported without stopping the import", async () => {
	const summary = await importContactsBytes(new TextEncoder().encode([vcard(1, `PHOTO;ENCODING=b:${JPEG}`), vcard(2, `PHOTO;ENCODING=b:${JPEG}`)].join("\r\n")), "vcard", settings, run(async () => ok(2, { photoTargets: ["p1@example.com", "p2@example.com"] }), {
		uploadPhoto: async () => { throw new Error("Upload failed"); },
	}));
	assert.equal(summary.photosFailed, 2);
	assert.equal(summary.created, 2);
	assert.deepEqual(summary.errors, ["Upload failed"]);
});

test("photos are skipped when the option is off", async () => {
	const uploads = [];
	await importContactsBytes(new TextEncoder().encode(vcard(1, `PHOTO;ENCODING=b:${JPEG}`)), "vcard", { ...settings, photos: false }, run(async () => ok(1, { photoTargets: ["p1@example.com"] }), { uploadPhoto: async (address) => { uploads.push(address); } }));
	assert.deepEqual(uploads, []);
});

test("a Google CSV is sent as its header and raw rows", async () => {
	const csv = "First Name,Last Name,E-mail 1 - Value\r\nJane,Doe,j@example.com\r\nNo,Mail,\r\nBob,Roe,b@example.com\r\n";
	const bodies = [];
	const summary = await importContactsBytes(new TextEncoder().encode(csv), "csv", settings, run(async (body) => (bodies.push(body), ok(body.csv.rows.length))));
	assert.equal(bodies.length, 1);
	assert.equal(bodies[0].format, "google-csv");
	assert.deepEqual(bodies[0].csv.header, ["First Name", "Last Name", "E-mail 1 - Value"]);
	assert.deepEqual(bodies[0].csv.rows, [["Jane", "Doe", "j@example.com"], ["Bob", "Roe", "b@example.com"]]);
	assert.equal(summary.cards, 3);
	assert.equal(summary.noEmail, 1);
	await assert.rejects(importContactsBytes(new TextEncoder().encode("date,amount\r\n1,2\r\n"), "csv", settings, run(async () => ok(0))), (error) => error.key === "importPage.takeoutDataContactsNotGoogleCsv" && /not a Google contacts/i.test(error.message));
});

test("a body the server cannot take (413, 500, network) is halved down to single cards, and one that still fails is counted", async () => {
	const sizes = [];
	const summary = await importContactsBytes(vcf(8), "vcard", settings, run(async (body) => {
		sizes.push(body.items.length);
		if (body.items.length > 2) return { status: 413, data: { error: "Request body is too large" } };
		if (body.items.some((item) => item.vcard.includes("Person 5"))) return { status: 500, data: { error: "boom" } };
		return ok(body.items.length);
	}));
	assert.ok(sizes.includes(4) && sizes.includes(2) && sizes.includes(1));
	assert.equal(summary.created, 7);
	assert.equal(summary.failed, 1);
	assert.deepEqual(summary.errors, ["boom"]);
});

test("a 429 waits (Retry-After first) and retries the same batch, then stops with rateLimited", async () => {
	const waits = [];
	let calls = 0;
	const summary = await importContactsBytes(vcf(150), "vcard", settings, run(async (body) => {
		calls++;
		return calls === 1 ? { status: 429, retryAfterMs: 5000, data: {} } : ok(body.items.length);
	}, { sleep: async (ms) => { waits.push(ms); } }));
	assert.deepEqual(waits, [5000]);
	assert.equal(summary.created, 150);
	assert.equal(summary.rateLimited, false);
	const limited = await importContactsBytes(vcf(5), "vcard", settings, run(async () => ({ status: 429, data: {} }), { sleep: async (ms) => { waits.push(ms); } }));
	assert.equal(limited.rateLimited, true);
	assert.equal(limited.created, 0);
});

test("other refusals (signed out, mailbox not found, migrations pending) stop the import with the server's message", async () => {
	for (const status of [401, 404, 409]) {
		await assert.rejects(importContactsBytes(vcf(3), "vcard", settings, run(async () => ({ status, data: { error: `E${status}` } }))), new RegExp(`E${status}`));
	}
});

test("a card too large for one request alone is counted, not sent", async () => {
	const big = new TextEncoder().encode(vcard(1, ...Array.from({ length: 20 }, (_, n) => `NOTE:${"€".repeat(20_000)}${n}`)) + "\r\n" + vcard(2));
	const bodies = [];
	const summary = await importContactsBytes(big, "vcard", settings, run(async (body) => (bodies.push(body), ok(body.items.length))));
	assert.equal(summary.failed, 1);
	assert.equal(summary.created, 1);
	assert.equal(bodies.length, 1);
	assert.deepEqual(summary.errors, [{ key: "importPage.takeoutDataContactsTooLarge", params: { count: 1 } }]);
});

test("a CSV row too large for the request body is reported with a translatable notice", async () => {
	const header = ["First Name", "E-mail 1 - Value", ...Array.from({ length: 120 }, (_, n) => `X${n}`)].join(",");
	const row = ["Jane", "j@example.com", ...Array.from({ length: 120 }, () => "a".repeat(10_000))].join(",");
	const summary = await importContactsBytes(new TextEncoder().encode(`${header}\r\n${row}\r\n`), "csv", settings, run(async () => ok(1)));
	assert.equal(summary.failed, 1);
	assert.deepEqual(summary.errors, [{ key: "importPage.takeoutDataContactTooBig" }]);
});

test("Stop aborts between batches and reports it", async () => {
	const controller = new AbortController();
	const summary = await importContactsBytes(vcf(250), "vcard", settings, run(async (body) => { controller.abort(); return ok(body.items.length); }, { signal: controller.signal }));
	assert.equal(summary.aborted, true);
	assert.equal(summary.created, 100);
});

test("preview counts what an import would do and posts nothing", async () => {
	const text = [vcard(1, `PHOTO;ENCODING=b:${JPEG}`), vcard(2), "BEGIN:VCARD\r\nFN:Nobody\r\nEND:VCARD"].join("\r\n");
	const summary = await previewContactsBytes(new TextEncoder().encode(text), "vcard", {});
	assert.deepEqual([summary.cards, summary.withEmail, summary.noEmail, summary.noEmailNames], [3, 2, 1, ["Nobody"]]);
	assert.equal(summary.created, 0);
});
