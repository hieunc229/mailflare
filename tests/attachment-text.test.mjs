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
} = await load("attachment-text");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const encoder = new TextEncoder();

/** A minimal but valid PDF: one Helvetica text line per page. */
function pdf(pages, { corrupt = false } = {}) {
	const objects = [];
	const pageIds = pages.map((_, index) => 3 + index * 2);
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
	pages.forEach((text, index) => {
		const contentId = 4 + index * 2;
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${pageIds.length * 2 + 3} 0 R >> >> >>`);
		const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
		objects.push(`<< /Length ${corrupt && index === 0 ? stream.length + 40 : stream.length} >>\nstream\n${stream}\nendstream`);
	});
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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
function bucket(objects) {
	let gets = 0;
	return {
		gets: () => gets,
		get: async (key) => {
			gets += 1;
			const bytes = objects[key];
			if (!bytes) return null;
			return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
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
	assert.equal(result.status, "done");
	assert.equal(result.text, "Hello, wörld\nsecond line");
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

test("a corrupt PDF fails without throwing", async () => {
	const result = await assertNotThrown(() => extractAttachmentText("application/pdf", encoder.encode("this is not a PDF at all")));
	assert.deepEqual(result, { status: "failed", text: null });
});

async function fixture(t, { contentType = "text/plain", bytes = encoder.encode("draft body"), r2Key = "attachments/m1/a1/a.txt", status } = {}) {
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
		contentType, bytes.byteLength, r2Key, now,
	);
	if (status) run("UPDATE message_attachments SET extract_status = ? WHERE id = 'a1'", status);
	const row = () => database.db.prepare("SELECT extract_status AS status, extracted_text AS text, extracted_at AS at FROM message_attachments WHERE id = 'a1'").get();
	const env = () => ({ DB: database, BUCKET: bucket({ [r2Key]: bytes }) });
	return { database, row, env };
}

test("the ingest hook records text on the row and never throws", async (t) => {
	const { row, env } = await fixture(t);
	const result = await extractStoredAttachmentText(env(), { id: "a1", contentType: "text/plain", content: encoder.encode("hello") });
	assert.deepEqual(result, { status: "done", text: "hello" });
	const stored = row();
	assert.equal(stored.status, "done");
	assert.equal(stored.text, "hello");
	assert.ok(stored.at);

	const failed = await assertNotThrown(() => extractStoredAttachmentText(env(), { id: "a1", contentType: "application/pdf", content: encoder.encode("broken") }));
	assert.equal(failed.status, "failed");
	assert.equal(row().status, "failed");
});

test("a row written before extraction existed is extracted on first use, then read from the column", async (t) => {
	const { row, env } = await fixture(t, { bytes: encoder.encode("backfilled body") });
	const state = env();
	assert.equal(row().status, "none");
	assert.equal(row().text, null);

	const first = await getAttachmentText(state, "a1");
	assert.deepEqual(first, { status: "done", text: "backfilled body" });
	assert.equal(state.BUCKET.gets(), 1, "the object is read once");
	assert.equal(row().status, "done");
	assert.equal(row().text, "backfilled body");

	const second = await getAttachmentText(state, "a1");
	assert.deepEqual(second, { status: "done", text: "backfilled body" });
	assert.equal(state.BUCKET.gets(), 1, "a stored row needs no second object read");
});

test("an unknown attachment has no text", async (t) => {
	const { env } = await fixture(t);
	assert.equal(await getAttachmentText(env(), "missing"), null);
});

test("a skipped row stays skipped and a missing object fails without throwing", async (t) => {
	const skipped = await fixture(t, { contentType: "image/png", bytes: encoder.encode("png") });
	assert.deepEqual(await getAttachmentText(skipped.env(), "a1"), { status: "skipped", text: null });
	assert.equal(skipped.row().status, "skipped");

	const missing = await fixture(t);
	const state = missing.env();
	state.BUCKET = bucket({});
	const result = await assertNotThrown(() => getAttachmentText(state, "a1"));
	assert.deepEqual(result, { status: "failed", text: null });
	assert.equal(missing.row().status, "failed", "a missing object is recorded, not retried forever");
});

test("re-extracting a stored row is idempotent", async (t) => {
	const { row, env } = await fixture(t);
	const state = env();
	const first = await extractStoredAttachmentText(state, { id: "a1", contentType: "text/plain", content: encoder.encode("same bytes") });
	const firstAt = row().at;
	assert.deepEqual(first, { status: "done", text: "same bytes" });
	const second = await extractStoredAttachmentText(state, { id: "a1", contentType: "text/plain", content: encoder.encode("same bytes") });
	assert.deepEqual(second, first);
	assert.equal(row().text, "same bytes");
	assert.ok(row().at >= firstAt);
});
