import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Inside the repository so the bundled module resolves `unpdf` from node_modules.
const outDir = mkdtempSync(join(root, "tests", ".tmp-attachment-text-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export {
				MAX_EXTRACTED_TEXT_BYTES,
				MAX_EXTRACTION_PDF_PAGES,
				MAX_EXTRACTION_SOURCE_BYTES,
				extractAttachmentText,
				extractInlineAttachmentText,
				getAttachmentText,
				isExtractableContentType,
				isTextAttachment,
			} from "./src/lib/email/attachment-text";
			export { storeMessageAttachments } from "./src/lib/email/attachments";
			export { prepareOutboundAttachments } from "./src/lib/email/cloud-attachment-utils";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "attachment-text.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "unpdf"],
	logLevel: "silent",
});
await build({
	entryPoints: {
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const {
	MAX_EXTRACTED_TEXT_BYTES,
	MAX_EXTRACTION_PDF_PAGES,
	MAX_EXTRACTION_SOURCE_BYTES,
	extractAttachmentText,
	extractInlineAttachmentText,
	getAttachmentText,
	isExtractableContentType,
	isTextAttachment,
	storeMessageAttachments,
	prepareOutboundAttachments,
} = await load("attachment-text");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const encoder = new TextEncoder();

/**
 * A minimal but valid PDF: one Helvetica text line per page.
 * `declaredLength` overrides a page stream's /Length (a stream that stops short
 * keeps its written length, while the rest of the file still parses), and
 * `indirectLength` writes /Length as a reference to another object.
 */
function pdf(pages, { declaredLength, indirectLength = false } = {}) {
	const objects = [];
	const pageIds = pages.map((_, index) => 3 + index * 2);
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
	pages.forEach((text, index) => {
		const contentId = 4 + index * 2;
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${pageIds.length * 2 + 3} 0 R >> >> >>`);
		const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
		const lengthId = pageIds.length * 2 + 4 + index;
		const declared = indirectLength ? `${lengthId} 0 R` : String(declaredLength ?? stream.length);
		objects.push(`<< /Length ${declared} >>\nstream\n${stream}\nendstream`);
	});
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	if (indirectLength) {
		pages.forEach((_, index) => {
			const stream = `BT /F1 18 Tf 20 100 Td (${pages[index]}) Tj ET`;
			objects.push(String(stream.length));
		});
	}
	let out = "%PDF-1.4\n";
	const offsets = [];
	objects.forEach((body, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return encoder.encode(out);
}

/** Cut a PDF off inside its first page's content stream, as an interrupted write would. */
function truncatedPdf() {
	const text = new TextDecoder().decode(pdf(["a page that never finishes"]));
	const cut = text.indexOf("stream\n") + "stream\n".length + 6;
	return encoder.encode(text.slice(0, cut));
}

function latin1(text) {
	const bytes = Buffer.from(text, "latin1");
	return new Uint8Array(bytes);
}

/** A BUCKET stub that counts reads and records the options each read used. */
function bucket(objects, { onGet } = {}) {
	let gets = 0;
	const reads = [];
	return {
		gets: () => gets,
		reads,
		put: async () => {},
		head: async (key) => (key in objects ? { size: objects[key].byteLength } : null),
		get: async (key, options) => {
			gets += 1;
			reads.push({ key, options });
			if (onGet) await onGet(key);
			const bytes = objects[key];
			if (!bytes) return null;
			// A range read returns at most that many bytes, like R2.
			const slice = options?.range?.length ? bytes.subarray(0, options.range.length) : bytes;
			return { arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
		},
	};
}

function assertNotThrown(fn) {
	return fn().then(
		(value) => value,
		(error) => assert.fail(`threw instead of reporting: ${error}`),
	);
}

test("text, PDF and nothing else are extractable", () => {
	assert.equal(isExtractableContentType("text/plain"), true);
	assert.equal(isExtractableContentType("text/csv; charset=utf-8"), true);
	assert.equal(isExtractableContentType("APPLICATION/PDF"), true);
	assert.equal(isExtractableContentType("application/pdf; name=a.pdf"), true);
	assert.equal(isExtractableContentType("image/png"), false);
	assert.equal(isExtractableContentType("application/octet-stream"), false);
	assert.equal(isExtractableContentType("applications/pdf"), false);
	assert.equal(isExtractableContentType(""), false);
	// Only text is ever parsed inline.
	assert.equal(isTextAttachment("text/plain"), true);
	assert.equal(isTextAttachment("application/pdf"), false);
	assert.equal(isTextAttachment("image/png"), false);
});

test("text attachments decode as UTF-8", async () => {
	const result = await extractAttachmentText("text/plain", encoder.encode("Hello, wörld\nsecond line"));
	assert.deepEqual(result, { status: "done", text: "Hello, wörld\nsecond line" });
});

test("a declared charset is honoured and an unknown one falls back to UTF-8", async () => {
	const declared = await extractAttachmentText("text/plain; charset=iso-8859-1", latin1("café"));
	assert.equal(declared.text, "café");
	const unknown = await extractAttachmentText("text/plain; charset=x-not-a-charset", latin1("café"));
	assert.equal(unknown.status, "done", "an unusable charset label must not fail extraction");
	assert.ok(unknown.text.startsWith("caf"), unknown.text);
});

test("text that cannot be stored verbatim is made storable", async () => {
	const result = await extractAttachmentText("text/plain", encoder.encode("a\u0000b\r\nc\rd\u0007"));
	assert.equal(result.text, "ab\nc\nd");
});

test("unsupported content types are skipped unread", async () => {
	const result = await extractAttachmentText("image/png", encoder.encode("not text"));
	assert.deepEqual(result, { status: "skipped", text: null });
});

test("oversize sources are skipped and long text is truncated to the cap", async () => {
	const oversize = new Uint8Array(MAX_EXTRACTION_SOURCE_BYTES + 1).fill(0x41);
	assert.deepEqual(await extractAttachmentText("text/plain", oversize), { status: "skipped", text: null });

	const long = await extractAttachmentText("text/plain", new Uint8Array(MAX_EXTRACTED_TEXT_BYTES * 2).fill(0x41));
	assert.equal(long.status, "done");
	assert.equal(encoder.encode(long.text).byteLength, MAX_EXTRACTED_TEXT_BYTES, "text is cut exactly at the store cap");

	// A multi-byte character split by the cap is dropped rather than stored half-decoded.
	const split = await extractAttachmentText("text/plain", encoder.encode("é".repeat(MAX_EXTRACTED_TEXT_BYTES / 2 + 1)));
	assert.equal(split.status, "done");
	assert.ok(encoder.encode(split.text).byteLength <= MAX_EXTRACTED_TEXT_BYTES);
	assert.ok(!split.text.endsWith("\uFFFD"), "no replacement character at the cut");
});

test("an empty file holds no text and is not damage", async () => {
	assert.deepEqual(await extractAttachmentText("application/pdf", new Uint8Array(0)), { status: "done", text: null });
	assert.deepEqual(await extractAttachmentText("text/plain", new Uint8Array(0)), { status: "done", text: null });
});

test("a PDF's text is extracted page by page", async () => {
	const result = await extractAttachmentText("application/pdf", pdf(["Invoice total 42 EUR", "Thanks for your business"]));
	assert.equal(result.status, "done");
	assert.match(result.text, /Invoice total 42 EUR/);
	assert.match(result.text, /Thanks for your business/);
});

test("pages past the cap are not read", async () => {
	const pages = Array.from({ length: MAX_EXTRACTION_PDF_PAGES + 1 }, (_, index) => `Page ${index + 1}`);
	const result = await extractAttachmentText("application/pdf", pdf(pages));
	assert.equal(result.status, "done");
	assert.match(result.text, /Page 1\b/);
	assert.doesNotMatch(result.text, new RegExp(`Page ${MAX_EXTRACTION_PDF_PAGES + 1}\\b`));
});

test("a PDF whose /Length is an indirect reference still extracts", async () => {
	const result = await extractAttachmentText("application/pdf", pdf(["indirect length"], { indirectLength: true }));
	assert.equal(result.status, "done");
	assert.match(result.text, /indirect length/);
});

test("page text containing the words stream and endstream is never failed", async () => {
	// Byte occurrences in text are not structure: no scanner may turn this into a
	// failure. How much text the parser recovers around the literal is its call.
	const result = await extractAttachmentText("application/pdf", pdf(["stream and endstream in prose"]));
	assert.equal(result.status, "done", "a healthy PDF must never be recorded as failed");
	assert.match(result.text, /stream and end/);
});

test("a file cut off inside a page stream fails", async () => {
	const result = await extractAttachmentText("application/pdf", truncatedPdf());
	assert.deepEqual(result, { status: "failed", text: null });
});

test("a stream whose declared length is too large is left to the parser", async () => {
	// The declared /Length disagrees with the bytes, but the page still reads: the
	// parser's result is the verdict, not a guess from the numbers in the file.
	const result = await extractAttachmentText("application/pdf", pdf(["page with a stale length"], { declaredLength: 400 }));
	assert.equal(result.status, "done");
	assert.match(result.text ?? "", /page with a stale length|^$/);
});

test("bytes that are not a PDF fail without throwing", async () => {
	const result = await assertNotThrown(() => extractAttachmentText("application/pdf", encoder.encode("this is not a PDF at all")));
	assert.deepEqual(result, { status: "failed", text: null });
});

test("a PDF with no text at all is done with no stored text", async () => {
	const result = await extractAttachmentText("application/pdf", pdf([""]));
	assert.equal(result.status, "done");
	assert.equal(result.text, null);
});

test("a Node Buffer input is not detached by the parser", async () => {
	// Buffer#slice returns a view, so a copy that trusts slice() would hand the
	// caller's bytes to pdf.js to detach.
	const source = Buffer.from(pdf(["buffer backed document"]));
	const length = source.byteLength;
	const result = await extractAttachmentText("application/pdf", source);
	assert.equal(result.status, "done");
	assert.match(result.text, /buffer backed document/);
	assert.equal(source.byteLength, length, "the caller's Buffer keeps its bytes");
	assert.match(source.subarray(0, 5).toString("latin1"), /^%PDF-/);
});

async function fixture(t, { contentType = "text/plain", bytes = encoder.encode("draft body"), r2Key = "attachments/m1/a1/a.txt", status, size } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = Math.floor(Date.now() / 1000);
	const run = (sql, ...params) => database.db.prepare(sql).run(...params);
	run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u', 'u@example.com', 'U', 'x', ?)", now);
	run("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'u', 'example.com', 'zone', ?)", now);
	run("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb', 'u', 'd', 'me', 'personal', ?)", now);
	run("INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('m1', 'mb', 'u', 'inbound', 'a@b.test', 'me@example.com', 's', 'received', ?)", now);
	run(
		"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('a1', 'm1', 'a.txt', ?, ?, ?, ?)",
		contentType, size ?? bytes.byteLength, r2Key, now,
	);
	if (status) run("UPDATE message_attachments SET extract_status = ? WHERE id = 'a1'", status);
	const row = () => database.db.prepare("SELECT extract_status AS status, extracted_text AS text, extracted_at AS at FROM message_attachments WHERE id = 'a1'").get();
	const findByFilename = (filename) => database.db.prepare("SELECT extract_status AS status, extracted_text AS text FROM message_attachments WHERE filename = ?").get(filename);
	const env = (objects = { [r2Key]: bytes }, options) => ({ DB: database, BUCKET: bucket(objects, options) });
	return { database, row, findByFilename, env };
}

test("the shared writer decodes text inline only, and leaves PDF to the lazy path", async (t) => {
	const { env, findByFilename } = await fixture(t);
	const state = env();

	// A request-path caller stores the attachment and leaves the row at "none".
	await storeMessageAttachments(state, "m1", [{ filename: "a.txt", type: "text/plain", content: encoder.encode("request body").buffer.slice(0) }], { validate: false });
	assert.deepEqual({ ...findByFilename("a.txt") }, { status: "none", text: null }, "a request path must not pay for extraction");

	// A queue consumer decodes text attachments inline.
	await storeMessageAttachments(state, "m1", [{ filename: "b.txt", type: "text/plain", content: encoder.encode("queue body").buffer.slice(0) }], { validate: false, extractText: true });
	assert.deepEqual({ ...findByFilename("b.txt") }, { status: "done", text: "queue body" });

	// A PDF is never parsed inline, not even for a queue consumer: delivery must
	// not wait on a parser whose CPU a platform kill can cut off.
	await storeMessageAttachments(state, "m1", [{ filename: "c.pdf", type: "application/pdf", content: pdf(["queue pdf"]).buffer.slice(0) }], { validate: false, extractText: true });
	assert.deepEqual({ ...findByFilename("c.pdf") }, { status: "none", text: null }, "PDF stays for getAttachmentText");
});

test("the shared writer leaves the caller's bytes intact for an immediate send", async (t) => {
	const { env, findByFilename } = await fixture(t, { contentType: "application/pdf" });
	// The outbound path keeps using the array it passed in (send.ts:150,185,246).
	const source = pdf(["outbound invoice 42"]);
	const content = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const original = source.slice();

	const attachments = [{ filename: "invoice.pdf", type: "application/pdf", content, disposition: "attachment" }];
	await storeMessageAttachments(env(), "m1", attachments, { validate: false, extractText: true });
	assert.equal(findByFilename("invoice.pdf").status, "none", "a PDF is not parsed by the writer");

	assert.doesNotThrow(() => new Uint8Array(content), "the caller's buffer must not be detached");
	assert.deepEqual(new Uint8Array(content), original, "byte identity after the shared writer");

	// The immediate send reads the same array, then base64s it for the provider.
	const sent = await prepareOutboundAttachments({}, "cloudflare", attachments, { subject: "s", headers: {} });
	assert.equal(sent.attachments.length, 1);
	assert.doesNotThrow(() => Buffer.from(sent.attachments[0].content).toString("base64"));
	assert.deepEqual(new Uint8Array(sent.attachments[0].content), original, "the sent bytes are the stored bytes");
});

test("the inline helper decodes text and defers everything else", async (t) => {
	const { row, env } = await fixture(t);
	const result = await extractInlineAttachmentText(env(), { id: "a1", contentType: "text/plain", content: encoder.encode("hello") });
	assert.deepEqual(result, { status: "done", text: "hello", persisted: true });
	assert.equal(row().status, "done");
	assert.ok(row().at);

	const deferred = await extractInlineAttachmentText(env(), { id: "a1", contentType: "application/pdf", content: pdf(["deferred"]) });
	assert.equal(deferred, null, "PDF is never parsed inline");
	assert.equal(row().status, "done", "the existing decision is untouched");
});

test("a detached caller buffer is recorded as failed, not thrown", async (t) => {
	const { row, env } = await fixture(t);
	const content = encoder.encode("hello").buffer.slice(0);
	// Detaching it stands for any caller that reuses its own buffer elsewhere.
	content.transfer();
	const result = await assertNotThrown(() => extractInlineAttachmentText(env(), { id: "a1", contentType: "text/plain", content }));
	assert.deepEqual(result, { status: "failed", text: null, persisted: true });
	assert.equal(row().status, "failed");
});

test("a row that cannot be written reports no confirmed decision", async (t) => {
	const { env } = await fixture(t);
	const state = env();
	// Closing the database makes the UPDATE throw while the parse still succeeds.
	state.DB.db.close();
	const result = await assertNotThrown(() => extractInlineAttachmentText(state, { id: "a1", contentType: "text/plain", content: encoder.encode("hello") }));
	assert.deepEqual(result, { status: "done", text: "hello", persisted: false }, "the parse is reported, no decision is confirmed");
});

test("a row written before extraction existed is extracted on first use, then read from the column", async (t) => {
	const { row, env } = await fixture(t, { bytes: encoder.encode("backfilled body") });
	const state = env();
	assert.equal(row().status, "none");
	assert.equal(row().text, null);

	const first = await getAttachmentText(state, "a1");
	assert.deepEqual(first, { status: "done", text: "backfilled body", persisted: true });
	assert.equal(state.BUCKET.gets(), 1, "the object is read once");
	assert.equal(row().status, "done");
	assert.equal(row().text, "backfilled body");

	const second = await getAttachmentText(state, "a1");
	assert.deepEqual(second, { status: "done", text: "backfilled body", persisted: true });
	assert.equal(state.BUCKET.gets(), 1, "a stored row needs no second object read");
});

test("an unknown attachment has no text", async (t) => {
	const { env } = await fixture(t);
	assert.equal(await getAttachmentText(env(), "missing"), null);
});

test("the lazy path decides unsupported and oversize rows without touching the object", async (t) => {
	const unsupported = await fixture(t, { contentType: "image/png", bytes: encoder.encode("png") });
	const unsupportedState = unsupported.env();
	assert.deepEqual(await getAttachmentText(unsupportedState, "a1"), { status: "skipped", text: null, persisted: true });
	assert.equal(unsupportedState.BUCKET.gets(), 0, "an unsupported type is never read");

	// A row whose stored size already exceeds the cap is skipped without a read.
	const oversize = await fixture(t, { size: MAX_EXTRACTION_SOURCE_BYTES + 1 });
	const oversizeState = oversize.env();
	assert.deepEqual(await getAttachmentText(oversizeState, "a1"), { status: "skipped", text: null, persisted: true });
	assert.equal(oversizeState.BUCKET.gets(), 0, "an oversize row is never read");
});

test("the lazy path caps the read so stale size metadata cannot bypass the bound", async (t) => {
	const huge = new Uint8Array(MAX_EXTRACTION_SOURCE_BYTES + 4096).fill(0x41);
	// The row claims a small size, the object is larger than the cap.
	const { env } = await fixture(t, { bytes: huge, size: 10 });
	const state = env();
	assert.deepEqual(await getAttachmentText(state, "a1"), { status: "skipped", text: null, persisted: true });
	assert.equal(state.BUCKET.gets(), 1);
	assert.deepEqual(state.BUCKET.reads[0].options, { range: { offset: 0, length: MAX_EXTRACTION_SOURCE_BYTES + 1 } }, "the read is bounded, not a whole-object buffer");
});

test("an empty object is done, even where a ranged read of it fails", async (t) => {
	// A runtime may refuse a range read of an empty object; its head still says it is empty.
	const empty = await fixture(t, { bytes: new Uint8Array(0), contentType: "application/pdf" });
	const readable = empty.env();
	assert.deepEqual(await getAttachmentText(readable, "a1"), { status: "done", text: null, persisted: true });
	assert.equal(empty.row().status, "done");

	const refusing = await fixture(t, { bytes: new Uint8Array(0), contentType: "application/pdf" });
	const state = refusing.env();
	const failingBucket = {
		get: async () => {
			throw new Error("range read of an empty object failed");
		},
		head: async () => ({ size: 0 }),
	};
	assert.deepEqual(await getAttachmentText({ ...state, BUCKET: failingBucket }, "a1"), { status: "done", text: null, persisted: true });
	assert.equal(refusing.row().status, "done", "a healthy empty file is not damage");

	// The same failure with a non-empty object is a real read failure.
	const broken = await fixture(t);
	const brokenState = broken.env();
	const brokenBucket = {
		get: async () => {
			throw new Error("read failed");
		},
		head: async () => ({ size: 12 }),
	};
	assert.deepEqual(await getAttachmentText({ ...brokenState, BUCKET: brokenBucket }, "a1"), { status: "failed", text: null, persisted: true });
	assert.equal(broken.row().status, "failed");
});

test("a skipped row stays skipped and a missing object fails without throwing", async (t) => {
	const skipped = await fixture(t, { contentType: "image/png", bytes: encoder.encode("png") });
	assert.deepEqual(await getAttachmentText(skipped.env(), "a1"), { status: "skipped", text: null, persisted: true });
	assert.equal(skipped.row().status, "skipped");

	const missing = await fixture(t);
	const state = missing.env({});
	const result = await assertNotThrown(() => getAttachmentText(state, "a1"));
	assert.deepEqual(result, { status: "failed", text: null, persisted: true });
	assert.equal(missing.row().status, "failed", "a missing object is recorded, not retried forever");
});

test("concurrent first readers do not overwrite each other's result", async (t) => {
	const first = encoder.encode("first reader");
	const second = encoder.encode("second reader");
	// Alternate what the object holds, so each reader parses different bytes.
	let calls = 0;
	const { env, row } = await fixture(t);
	const state = {
		DB: env().DB,
		BUCKET: {
			put: async () => {},
			head: async () => null,
			get: async () => {
				calls += 1;
				const bytes = calls === 1 ? first : second;
				await new Promise((resolve) => setTimeout(resolve, calls === 1 ? 20 : 0));
				return { arrayBuffer: async () => bytes.buffer.slice(0) };
			},
		},
	};

	const [a, b] = await Promise.all([getAttachmentText(state, "a1"), getAttachmentText(state, "a1")]);
	const stored = row();
	assert.ok(stored.status === "done");
	// Whichever reader won, both callers report what the row holds and the row is not rewritten again.
	assert.deepEqual({ a, b }, { a: { status: "done", text: stored.text, persisted: true }, b: { status: "done", text: stored.text, persisted: true } });
	assert.ok([first, second].some((bytes) => new TextDecoder().decode(bytes) === stored.text), "the row holds a whole reader's result");

	const third = await getAttachmentText(state, "a1");
	assert.deepEqual(third, { status: "done", text: stored.text, persisted: true });
	assert.equal(row().text, stored.text, "a third read does not overwrite the row");
});

test("re-extracting a decided row reports it as already recorded", async (t) => {
	const { row, env } = await fixture(t);
	const state = env();
	const first = await extractInlineAttachmentText(state, { id: "a1", contentType: "text/plain", content: encoder.encode("same bytes") });
	const firstAt = row().at;
	assert.deepEqual(first, { status: "done", text: "same bytes", persisted: true });
	const second = await extractInlineAttachmentText(state, { id: "a1", contentType: "text/plain", content: encoder.encode("same bytes") });
	assert.deepEqual(second, { status: "done", text: "same bytes", persisted: true });
	assert.equal(row().text, "same bytes");
	assert.equal(row().at, firstAt, "a decided row is not written a second time");
});
