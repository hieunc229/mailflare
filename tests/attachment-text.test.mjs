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
				extractStoredAttachmentText,
				getAttachmentText,
				isExtractableContentType,
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
	extractStoredAttachmentText,
	getAttachmentText,
	isExtractableContentType,
	storeMessageAttachments,
	prepareOutboundAttachments,
} = await load("attachment-text");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const encoder = new TextEncoder();

/**
 * A minimal but valid PDF: one Helvetica text line per page.
 * `declaredLength` overrides a page stream's /Length (a stream cut short keeps
 * its original length, which is what a truncated PDF looks like), and
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

function latin1(text) {
	const bytes = Buffer.from(text, "latin1");
	return new Uint8Array(bytes);
}

/** A BUCKET stub that counts reads, so the lazy path can be checked for a second fetch. */
function bucket(objects, { onGet } = {}) {
	let gets = 0;
	const reads = [];
	return {
		gets: () => gets,
		reads,
		put: async () => {},
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
	assert.equal(result.status, "done", "an uncheckable stream must not be reported as truncated");
	assert.match(result.text, /indirect length/);
});

test("a truncated page stream fails instead of being stored as done with no text", async () => {
	// The stream is cut short but keeps the /Length its producer wrote: pdf.js
	// recovers silently, so the damage has to be seen before it is handed over.
	const result = await extractAttachmentText("application/pdf", pdf(["invoice cut off mid-stream"], { declaredLength: 200 }));
	assert.deepEqual(result, { status: "failed", text: null });
});

test("the word stream inside page text does not look like a cut", async () => {
	// Page text with real newlines around the keyword: the scanner must not take it
	// for a stream that stops short, and the page must still extract.
	const result = await extractAttachmentText("application/pdf", pdf(["before\nstream\nafter"]));
	assert.equal(result.status, "done");
	assert.match(result.text ?? "", /before/);
});

test("a file cut off inside a declared stream fails", async () => {
	const bytes = pdf(["whole page here"]);
	// Everything from the middle of the page's content stream onward is gone.
	const decoder = new TextDecoder();
	const text = decoder.decode(bytes);
	const cut = bytes.subarray(0, text.indexOf("stream\n") + "stream\n".length + 6);
	assert.deepEqual(await extractAttachmentText("application/pdf", cut), { status: "failed", text: null });
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
	const env = (objects = { [r2Key]: bytes }, options) => ({ DB: database, BUCKET: bucket(objects, options) });
	return { database, row, env };
}

test("the shared writer parses only when a queue consumer asks it to", async (t) => {
	const { env } = await fixture(t);
	const bytes = encoder.encode("queue body");
	const state = env();

	// A request-path caller stores the attachment and leaves the row at "none".
	await storeMessageAttachments(state, "m1", [{ filename: "a.txt", type: "text/plain", content: bytes.buffer.slice(0) }], { validate: false });
	const storedFirst = state.DB.db.prepare("SELECT extract_status AS status, extracted_text AS text FROM message_attachments WHERE filename = 'a.txt'").get();
	assert.deepEqual({ ...storedFirst }, { status: "none", text: null }, "a request path must not pay for a parse");

	// A queue consumer asks for the enrichment inline.
	await storeMessageAttachments(state, "m1", [{ filename: "b.txt", type: "text/plain", content: encoder.encode("second").buffer.slice(0) }], { validate: false, extractText: true });
	const enriched = state.DB.db.prepare("SELECT extract_status AS status, extracted_text AS text FROM message_attachments WHERE filename = 'b.txt'").get();
	assert.deepEqual({ ...enriched }, { status: "done", text: "second" });
});

test("the shared writer leaves the caller's bytes intact for an immediate send", async (t) => {
	const { env } = await fixture(t, { contentType: "application/pdf" });
	// The outbound path keeps using the array it passed in (send.ts:150,185,246),
	// and pdf.js detaches whatever buffer it is handed, so the writer must not give
	// it the caller's.
	const source = pdf(["outbound invoice 42"]);
	const content = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const original = source.slice();
	assert.equal(content.byteLength, original.byteLength);

	const state = env();
	const attachments = [{ filename: "invoice.pdf", type: "application/pdf", content, disposition: "attachment" }];
	await storeMessageAttachments(state, "m1", attachments, { validate: false, extractText: true });
	const storedRow = state.DB.db.prepare("SELECT extract_status AS status FROM message_attachments WHERE filename = 'invoice.pdf'").get();
	assert.equal(storedRow.status, "done", "the queue-side parse still happened");

	assert.doesNotThrow(() => new Uint8Array(content), "the caller's buffer must not be detached");
	assert.equal(content.byteLength, original.byteLength, "the caller's buffer keeps its bytes");
	assert.deepEqual(new Uint8Array(content), original, "byte identity after the shared writer");

	// The immediate send reads the same array, then base64s it for the provider.
	const sent = await prepareOutboundAttachments({}, "cloudflare", attachments, { subject: "s", headers: {} });
	assert.equal(sent.attachments.length, 1);
	assert.doesNotThrow(() => Buffer.from(sent.attachments[0].content).toString("base64"));
	assert.deepEqual(new Uint8Array(sent.attachments[0].content), original, "the sent bytes are the stored bytes");
});

test("the ingest hook records text on the row and never throws", async (t) => {
	const { row, env } = await fixture(t);
	const result = await extractStoredAttachmentText(env(), { id: "a1", contentType: "text/plain", content: encoder.encode("hello") });
	assert.deepEqual(result, { status: "done", text: "hello", persisted: true });
	const stored = row();
	assert.equal(stored.status, "done");
	assert.equal(stored.text, "hello");
	assert.ok(stored.at);

	const failed = await assertNotThrown(() => extractStoredAttachmentText(env(), { id: "a1", contentType: "application/pdf", content: encoder.encode("broken") }));
	assert.deepEqual(failed, { status: "failed", text: null, persisted: true }, "the row is already decided, so nothing is rewritten");
	assert.equal(row().status, "done", "a decided row keeps its first result");
});

test("a detached caller buffer is recorded as failed, not thrown", async (t) => {
	const { row, env } = await fixture(t);
	const content = encoder.encode("hello").buffer.slice(0);
	// Detaching it stands for any caller that reuses its own buffer elsewhere.
	content.transfer();
	const result = await assertNotThrown(() => extractStoredAttachmentText(env(), { id: "a1", contentType: "text/plain", content }));
	assert.deepEqual(result, { status: "failed", text: null, persisted: true });
	assert.equal(row().status, "failed");
});

test("a row that cannot be written keeps its text result and stays retryable", async (t) => {
	const { row, env } = await fixture(t);
	const state = env();
	// Closing the database makes the UPDATE throw while the parse still succeeds.
	state.DB.db.close();
	const result = await assertNotThrown(() => extractStoredAttachmentText(state, { id: "a1", contentType: "text/plain", content: encoder.encode("hello") }));
	assert.deepEqual(result, { status: "done", text: "hello", persisted: false }, "extraction is reported, persistence is not");
	void row;
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
	const first = await extractStoredAttachmentText(state, { id: "a1", contentType: "text/plain", content: encoder.encode("same bytes") });
	const firstAt = row().at;
	assert.deepEqual(first, { status: "done", text: "same bytes", persisted: true });
	const second = await extractStoredAttachmentText(state, { id: "a1", contentType: "text/plain", content: encoder.encode("same bytes") });
	assert.deepEqual(second, { status: "done", text: "same bytes", persisted: true });
	assert.equal(row().text, "same bytes");
	assert.equal(row().at, firstAt, "a decided row is not written a second time");
});
