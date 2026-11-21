import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test, { after, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import PostalMime from "postal-mime";
import bodystructure from "../server/imap/vendor/imapkit/bodystructure.js";
import envelope from "../server/imap/vendor/imapkit/envelope.js";
import addressparser from "../server/imap/vendor/imapkit/addressparser.js";
import { embeddedMessage, headerSection, normalizeLineBreaks, parseTree, render, resolveNode } from "../server/imap/vendor/imapkit/mimeparser.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-mime-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { synthesizeMessage } from "./src/lib/imap/synthesize.ts";
			export { getMessageIndex, readSection, indexMime, reviveLists, MimeIndexError, cacheKey } from "./src/lib/imap/fetch.ts";
			export { syncMailbox } from "./src/lib/imap/sync.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { openFileBucket } from "./server/runtime/file-bucket.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-mime-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { synthesizeMessage, getMessageIndex, readSection, indexMime, reviveLists, MimeIndexError, cacheKey, MimeIndexError, syncMailbox, SqliteDatabase, applyMigrations, openFileBucket } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const crlf = (lines) => lines.join("\r\n");
const tree = (lines) => parseTree(normalizeLineBreaks(crlf(lines)));

const mixed = [
	"From: =?UTF-8?B?w4RuZHJpcw==?= <a@x.test>",
	'To: b@x.test, "C D" <c@x.test>',
	"Subject: =?UTF-8?Q?h=C3=A9llo?=",
	"Date: Mon, 1 Jan 2024 10:00:00 +0000",
	"Message-ID: <m1@x.test>",
	"MIME-Version: 1.0",
	'Content-Type: multipart/mixed; boundary="B"',
	"",
	"--B",
	'Content-Type: multipart/alternative; boundary="A"',
	"",
	"--A",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"hi",
	"--A",
	"Content-Type: text/html",
	"",
	"<p>hi</p>",
	"--A--",
	"--B",
	"Content-Type: application/pdf; name=a.pdf",
	"Content-Disposition: attachment; filename=a.pdf",
	"Content-Transfer-Encoding: base64",
	"",
	"AAAA",
	"--B--",
	"",
];

test("vendored parser: BODYSTRUCTURE of mixed over alternative", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(bodystructure(tree(mixed)))), [
		[
			["text", "plain", ["charset", "utf-8"], null, null, "7bit", 2, 0, null, null, null, null],
			["text", "html", null, null, null, "7bit", 9, 0, null, null, null, null],
			"alternative", ["boundary", "A"], null, null, null,
		],
		["application", "pdf", ["name", "a.pdf"], null, null, "base64", 4, null, ["attachment", ["filename", "a.pdf"]], null, null],
		"mixed", ["boundary", "B"], null, null, null,
	]);
});

test("vendored parser: ENVELOPE keeps encoded words as sent and splits addresses", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(envelope(tree(mixed).parsedHeader))), [
		"Mon, 1 Jan 2024 10:00:00 +0000",
		"=?UTF-8?Q?h=C3=A9llo?=",
		[["=?UTF-8?B?w4RuZHJpcw==?=", null, "a", "x.test"]],
		[["=?UTF-8?B?w4RuZHJpcw==?=", null, "a", "x.test"]],
		[["=?UTF-8?B?w4RuZHJpcw==?=", null, "a", "x.test"]],
		[[null, null, "b", "x.test"], ["C D", null, "c", "x.test"]],
		null, null, null, "<m1@x.test>",
	]);
});

test("vendored parser: message/rfc822 part carries the inner envelope and structure", () => {
	const lines = [
		"From: a@x.test", "Content-Type: multipart/mixed; boundary=B", "", "--B", "Content-Type: message/rfc822", "",
		"From: in@x.test", "Subject: inner", "Message-ID: <in@x.test>", "", "inner body", "--B--", "",
	];
	const [part] = bodystructure(tree(lines));
	assert.deepEqual([part[0], part[1]], ["message", "rfc822"]);
	assert.equal(part[7][1], "inner");
	assert.deepEqual(part[8].slice(0, 2), ["text", "plain"]);
});

test("vendored parser: broken MIME is described, not rejected", () => {
	const noClose = tree(["Content-Type: multipart/mixed; boundary=B", "", "--B", "Content-Type: text/plain", "", "unterminated"]);
	assert.equal(bodystructure(noClose)[0][0], "text");
	const noBoundary = tree(["Content-Type: multipart/mixed", "", "body"]);
	assert.equal(bodystructure(noBoundary)[0], "multipart");
	for (const source of [["Subject: x"], ["Subject: x", ""], ["Subject: x", "", "b"]]) assert.equal(render(tree(source)), crlf(source), "the tree renders back to the octets it was parsed from");
});

test("vendored parser: bare line breaks are served as CRLF", () => {
	assert.equal(normalizeLineBreaks("A: b\n\nbody\n"), "A: b\r\n\r\nbody\r\n");
});

const nest = (depth, line = "x") => {
	let source = "Subject: x\r\n";
	for (let level = 0; level < depth; level += 1) source += `Content-Type: multipart/mixed; boundary=b${level}\r\n\r\n--b${level}\r\n`;
	return `${source}\r\n${line}\r\n`;
};
const depthOfTree = (root) => {
	let deepest = 0;
	const stack = [[root, 1]];
	while (stack.length) {
		const [node, depth] = stack.pop();
		deepest = Math.max(deepest, depth);
		for (const child of node.childNodes ?? []) stack.push([child, depth + 1]);
	}
	return deepest;
};
const countNodes = (root) => {
	let count = 0;
	const stack = [root];
	while (stack.length) {
		const node = stack.pop();
		count += 1;
		stack.push(...(node.childNodes ?? []));
	}
	return count;
};

test("vendored parser: deep nesting is parsed down to a limit and the rest is a leaf", () => {
	const source = nest(5000);
	const parsed = parseTree(source);
	assert.ok(depthOfTree(parsed) <= 66, "nesting stops near 64 levels");
	assert.ok(countNodes(parsed) < 100);
	assert.equal(render(parsed), source, "the tree still renders back to the octets it was parsed from");
	const shallow = parseTree(nest(10));
	assert.equal(depthOfTree(shallow), 11, "ordinary nesting is parsed in full");
});

test("vendored parser: embedded messages are parsed again only up to a multiple of the input size", () => {
	const messageLevels = (node) => {
		let levels = 0;
		for (let inner = node.message; inner; inner = inner.message) levels += 1;
		return levels;
	};
	const wrap = (levels, body) => {
		let source = `Subject: in\r\n\r\n${body}`;
		for (let level = 0; level < levels; level += 1) source = `Content-Type: message/rfc822\r\n\r\n${source}`;
		return source;
	};
	const large = wrap(30, "ab\r\n".repeat(100000));
	const parsed = parseTree(large);
	assert.ok(messageLevels(parsed) <= 4, `${messageLevels(parsed)} levels parsed`);
	assert.equal(render(parsed), large, "the rest is served byte for byte");
	assert.equal(messageLevels(parseTree(wrap(3, "ab\r\n".repeat(20000)))), 3, "a forward of a forward is parsed in full");
	assert.equal(messageLevels(parseTree(wrap(20, "ab\r\n"))), 20, "small embedded messages are parsed down to the depth limit");
});

test("vendored parser: parts beyond the limit stay in the part that is open", () => {
	let source = "Content-Type: multipart/mixed; boundary=b\r\n\r\n";
	for (let part = 0; part < 3000; part += 1) source += `--b\r\nContent-Type: text/plain\r\n\r\nline ${part}\r\n`;
	source += "--b--\r\n";
	const parsed = parseTree(source);
	assert.ok(parsed.childNodes.length <= 1000, `${parsed.childNodes.length} parts`);
	assert.ok(parsed.childNodes.length >= 900);
	assert.equal(render(parsed), source);
	const nested = parseTree(`Content-Type: multipart/mixed; boundary=o\r\n\r\n--o\r\nContent-Type: message/rfc822\r\n\r\n${source}--o--\r\n`);
	assert.ok(countNodes(nested) <= 1002, "the count covers embedded messages too");
});

test("vendored parser: oversized address fields are left unparsed", () => {
	const field = (length) => `a${".a".repeat(length)}@example.test`;
	const big = field(9000);
	assert.ok(big.length > 16384);
	const header = (name, value) => tree([`${name}: ${value}`, "", "x"]).parsedHeader;
	assert.deepEqual(header("From", big).from, []);
	assert.equal(envelope(header("From", big))[2], null, "ENVELOPE shows NIL for that field");
	assert.equal(envelope(header("From", big))[3], null, "and the Sender that falls back to it");
	assert.equal(envelope(header("To", "ok@example.test"))[5].length, 1);
	assert.equal(header("To", field(4000)).to.length, 1, "a long field under the limit is parsed");
	const split = tree([`To: ${field(5000)}`, `To: ${field(5000)}`, `To: ${field(5000)}`, "", "x"]).parsedHeader;
	assert.deepEqual(split.to, [], "the limit covers all fields of one name together");
});

test("vendored parser: address lists and text addresses are parsed in a single pass", () => {
	const list = Array.from({ length: 4000 }, (_, index) => `u${index}@example.test`).join(", ");
	assert.equal(addressparser(list).length, 4000);
	const groups = `g: ${list};`.repeat(1);
	assert.equal(addressparser(groups)[0].group.length, 4000);
	assert.deepEqual(addressparser("Some Name addr@host.test trailing"), [{ address: "addr@host.test", name: "Some Name trailing" }]);
	assert.deepEqual(addressparser("a.b.c.d. x.y@z.w."), [{ address: "x.y@z.w", name: "a.b.c.d. ." }]);
	assert.deepEqual(addressparser(`${"a.".repeat(6000)} b@c`), [{ address: "b@c", name: "a.".repeat(6000).trim() }]);
	assert.deepEqual(addressparser(`${"a ".repeat(3000)}`.trim()).length, 1);
});

test("vendored parser: long white space runs in header values are unfolded and trimmed in one pass", () => {
	const run = " ".repeat(50000);
	const parsed = tree([`Subject: a${run}b`, `Content-Type: text/plain; name="x${run}y"`, "", "x"]).parsedHeader;
	assert.equal(parsed.subject, `a${run}b`, "white space without a line break is kept");
	assert.equal(parsed["content-type"].params.name, `x${run}y`);
	assert.equal(tree(["Subject: a \r\n \t\r\n  b", "X-Folded: one", "\ttwo", "", "x"]).parsedHeader.subject, "a b", "a run with line breaks becomes one space");
	assert.equal(tree(["Content-Type: text/plain; name='  q  '", "", "x"]).parsedHeader["content-type"].params.name, "q", "quotes and spaces at the ends are removed");
});

// ---- synthesizeMessage ----

const baseRow = {
	id: "msg_abc123",
	fromAddr: '"Ann" <ann@example.test>',
	toAddr: "bob@example.test",
	ccAddr: null,
	bccAddr: null,
	replyTo: null,
	subject: "Hello",
	textBody: "plain text",
	htmlBody: null,
	providerMessageId: null,
	inReplyTo: null,
	references: null,
	createdAt: new Date("2024-03-05T10:20:30Z"),
};
const decode = (bytes) => Buffer.from(bytes).toString("latin1");
const synth = (row = {}, attachments = []) => synthesizeMessage({ ...baseRow, ...row }, attachments, { hostname: "mail.example.test" });
const headerOf = (text) => text.slice(0, text.indexOf("\r\n\r\n"));

test("synthesizeMessage is deterministic and parseable", async () => {
	const row = { htmlBody: "<p>hi</p>", ccAddr: "c@example.test", inReplyTo: "p1@example.test", references: "p0@example.test p1@example.test" };
	const attachments = [{ filename: "a.txt", contentType: "text/plain", disposition: "attachment", contentId: null, bytes: new TextEncoder().encode("attached") }];
	const first = synth(row, attachments);
	assert.deepEqual(synth(row, attachments), first, "same input, same bytes");
	const parsed = await PostalMime.parse(first);
	assert.equal(parsed.subject, "Hello");
	assert.equal(parsed.from.address, "ann@example.test");
	assert.equal(parsed.text.trim(), "plain text");
	assert.equal(parsed.html.trim(), "<p>hi</p>");
	assert.equal(parsed.attachments.length, 1);
	assert.equal(new TextDecoder().decode(parsed.attachments[0].content), "attached");
	assert.equal(parsed.messageId, "<msg_abc123@mail.example.test>");
	assert.equal(parsed.inReplyTo, "<p1@example.test>");
	assert.equal(parsed.date, "2024-03-05T10:20:30.000Z");
	assert.ok(!decode(first).includes("\n") || decode(first).split("\n").every((line) => line.endsWith("\r") || line === ""), "CRLF only");
});

test("synthesizeMessage layouts: text, html, alternative, mixed, related", () => {
	const type = (bytes) => /Content-Type: ([a-z/]+)/.exec(headerOf(decode(bytes)))[1];
	assert.equal(type(synth()), "text/plain");
	assert.equal(type(synth({ textBody: null, htmlBody: "<b>x</b>" })), "text/html");
	assert.equal(type(synth({ htmlBody: "<b>x</b>" })), "multipart/alternative");
	const file = { filename: "f.bin", contentType: "application/octet-stream", disposition: "attachment", contentId: null, bytes: new Uint8Array([1, 2, 3]) };
	assert.equal(type(synth({}, [file])), "multipart/mixed");
	const inline = { filename: "i.png", contentType: "image/png", disposition: "inline", contentId: "<cid1@x>", bytes: new Uint8Array([9]) };
	const tree = parseTree(normalizeLineBreaks(decode(synth({ htmlBody: '<img src="cid:cid1@x">' }, [inline]))));
	const [alt] = tree.childNodes ?? [tree];
	assert.equal(tree.parsedHeader["content-type"].value, "multipart/alternative");
	assert.equal(alt.parsedHeader["content-type"].value, "text/plain");
	assert.equal(tree.childNodes[1].parsedHeader["content-type"].value, "multipart/related", "html and its inline image travel together");
	assert.equal(tree.childNodes[1].childNodes[1].parsedHeader["content-id"], "<cid1@x>");
});

test("synthesizeMessage cannot be made to add headers or break structure", async () => {
	const bytes = synth({
		subject: "x\r\nBcc: evil@example.test",
		toAddr: '"Bob\r\nX-Injected: 1" <bob@example.test>, carol@example.test',
		providerMessageId: "<a@b>\r\nX-Other: 1",
		inReplyTo: "p\r\nX-Third: 1",
	}, [{ filename: 'x"\r\nX-Fourth: 1.txt', contentType: "text/plain\r\nX-Fifth: 1", disposition: "attachment", contentId: "c\r\nX-Sixth: 1", bytes: new Uint8Array([65]) }]);
	const text = decode(bytes);
	for (const name of ["Bcc", "X-Injected", "X-Other", "X-Third", "X-Fourth", "X-Fifth", "X-Sixth"]) assert.ok(!new RegExp(`^${name}:`, "mi").test(text), `${name} is not a header`);
	const parsed = await PostalMime.parse(bytes);
	assert.equal(parsed.to.length, 2);
	assert.equal(parsed.attachments.length, 1);
});

test("synthesizeMessage encodes non-ASCII subjects, names and file names", async () => {
	const subject = "Grüße ".repeat(20) + "日本語";
	const bytes = synth({ subject, fromAddr: '"Zoë Ünal" <zoe@example.test>', textBody: "ünïcode\ntwo" }, [
		{ filename: "résumé \"v2\".pdf", contentType: "application/pdf", disposition: "attachment", contentId: null, bytes: new Uint8Array([1]) },
	]);
	assert.ok([...bytes].every((byte) => byte < 128), "headers and bodies are 7-bit");
	assert.ok(decode(bytes).split("\r\n").every((line) => line.length <= 998));
	const parsed = await PostalMime.parse(bytes);
	assert.equal(parsed.subject, subject);
	assert.equal(parsed.from.name, "Zoë Ünal");
	assert.equal(parsed.text.replace(/\r\n/g, "\n").trim(), "ünïcode\ntwo");
	assert.equal(parsed.attachments[0].filename, 'résumé "v2".pdf');
});

test("synthesizeMessage keeps long reference chains within header line limits and never yields a message/* base64 part", async () => {
	const references = Array.from({ length: 200 }, (_, index) => `ref${index}@example.test`).join(" ");
	const bytes = synth({ references }, [{ filename: "m.eml", contentType: "message/rfc822", disposition: "attachment", contentId: null, bytes: new Uint8Array([65]) }]);
	const text = decode(bytes);
	assert.ok(text.split("\r\n").every((line) => line.length <= 998));
	assert.ok(!/Content-Type: message\//i.test(text));
	assert.equal((await PostalMime.parse(bytes)).references.trim().split(/\s+/).length, 200);
});

const headerLines = (bytes) => headerOf(decode(bytes)).split("\r\n");

test("synthesizeMessage folds long values without empty lines and keeps every line under 998", async () => {
	const rows = [
		{ subject: "é".repeat(2000) },
		{ subject: "héllo wörld ".repeat(300) },
		{ subject: "a".repeat(5000) },
		{ subject: `${"word ".repeat(400)}${"b".repeat(3000)}` },
		{ toAddr: `"${"N".repeat(4000)}" <n@example.test>, "${"Ö".repeat(300)}" <o@example.test>` },
		{ references: Array.from({ length: 800 }, (_, index) => `<r${index}@example.test>`).join(" ") },
	];
	for (const row of rows) {
		const bytes = synth(row);
		const lines = headerLines(bytes);
		assert.ok(lines.every((line) => line.length <= 998), "no line over 998");
		assert.ok(lines.every((line) => line.trim().length > 0), "no empty or white-space-only line inside the header");
		assert.ok(lines.every((line, index) => index === 0 || /^[ \t]/.test(line) || /^[A-Za-z-]+:/.test(line)), "every line is a field or a continuation");
		const parsed = await PostalMime.parse(bytes);
		if (row.subject) assert.equal(parsed.subject.replace(/\s+/g, " ").trim(), row.subject.replace(/\s+/g, " ").trim().replace(/^$/, ""));
		assert.equal(parsed.to.length, row.toAddr ? 2 : 1);
	}
});

test("synthesizeMessage keeps attachment headers short however long the file name is", async () => {
	const names = ["ü".repeat(400) + ".pdf", "n".repeat(3000) + ".txt", `${"日本語".repeat(60)} "quoted".bin`];
	const bytes = synth({}, names.map((filename) => ({ filename, contentType: `text/${"p".repeat(500)}`, disposition: "attachment", contentId: null, bytes: new Uint8Array([1, 2]) })));
	const text = decode(bytes);
	assert.ok(text.split("\r\n").every((line) => line.length <= 998), "no line over 998");
	assert.ok([...bytes].every((byte) => byte < 128));
	const parsed = await PostalMime.parse(bytes);
	assert.deepEqual(parsed.attachments.map((attachment) => attachment.filename), names);
	assert.ok(parsed.attachments.every((attachment) => attachment.mimeType === "application/octet-stream"), "an absurd content type is sent as opaque data");
});

test("synthesizeMessage writes display names as encoded words and addresses as valid addr-specs", async () => {
	const bytes = synth({ toAddr: '"Zoë Ünal" <zoe@exämple.test>, "d:e" <d:e@x.test>, plain@x.test, "Semi" <a;b,c@x.test>, <bad@exa_mple.test>, "Long" <' + "l".repeat(300) + "@x.test>, ünï@x.test" });
	const text = decode(bytes);
	const to = /^To: ([\s\S]*?)\r\n[A-Z]/m.exec(headerOf(text))[1].replace(/\r\n\s/g, " ");
	assert.match(to, /=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@xn--exmple-cua\.test>/, "RFC 2047 for the name, an A-label for the domain");
	assert.match(to, /"d:e"@x\.test/, "a local part with a colon is quoted");
	assert.match(to, /"a;b,c"@x\.test/);
	assert.ok(!to.includes("bad@"), "a domain that cannot be one drops the entry");
	assert.ok(!to.includes("l".repeat(300)), "a mailbox longer than a path can be is dropped");
	assert.ok(to.includes("plain@x.test"));
	assert.ok(to.includes(Buffer.from("ünï@x.test").toString("latin1")), "a non-ASCII local part is written as UTF-8 (RFC 6532)");
	const parsed = await PostalMime.parse(bytes);
	assert.deepEqual(parsed.to.map((address) => address.address), ["zoe@xn--exmple-cua.test", '"d:e"@x.test', "plain@x.test", '"a;b,c"@x.test', "ünï@x.test"]);
	assert.equal(parsed.to[0].name, "Zoë Ünal");
	const tree = parseTree(normalizeLineBreaks(decode(bytes)));
	assert.equal(envelope(tree.parsedHeader)[5].length, 5, "ENVELOPE agrees");
	assert.ok([...synth({ toAddr: "zoe@exämple.test" })].every((byte) => byte < 128), "an address without a non-ASCII local part keeps the message 7-bit");
});

// ---- fetch: index, cache and sections ----

const rfc822 = [
	"From: top@x.test", "Subject: outer", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="O"', "",
	"preamble", "--O", "Content-Type: text/plain", "", "first", "--O", "Content-Type: message/rfc822", "",
	"From: in@x.test", "Subject: inner", 'Content-Type: multipart/alternative; boundary="I"', "", "--I", "Content-Type: text/plain", "", "in-a", "--I", "Content-Type: text/html", "", "<i>in-b</i>", "--I--", "",
	"--O--", "epilogue", "",
];

/** The octets of a section worked out from the parsed tree, independent of the offsets the index records. */
function expected(source, path, kind) {
	const root = parseTree(source);
	const node = path === "" ? root : resolveNode(root, path);
	const message = path === "" ? root : embeddedMessage(node);
	if (kind === "all") return path === "" ? source : render(node, true);
	if (kind === "mime") return headerSection(node);
	if (kind === "header") return headerSection(message);
	return render(message, true);
}

for (const [name, lines, paths] of [
	["mixed over alternative", mixed, ["", "1", "1.1", "1.2", "2"]],
	["message/rfc822 part", rfc822, ["", "1", "2", "2.1", "2.2"]],
	["no parts at all", ["Subject: x", "", "just a body", ""], ["", "1"]],
	["header only, no blank line", ["Subject: x"], [""]],
	["multipart without boundary parameter", ["Content-Type: multipart/mixed", "", "body"], ["", "1"]],
	["multipart that never closes", ["Content-Type: multipart/mixed; boundary=B", "", "--B", "Content-Type: text/plain", "", "cut off"], ["", "1"]],
]) {
	test(`indexMime offsets match the parsed tree: ${name}`, () => {
		const source = normalizeLineBreaks(crlf(lines));
		const index = indexMime(source);
		assert.equal(index.size, source.length);
		for (const path of paths) {
			const entry = index.ranges[path];
			assert.ok(entry, `part ${JSON.stringify(path)} is indexed`);
			const [start, bodyStart, end] = entry.span;
			const node = path === "" ? parseTree(source) : resolveNode(parseTree(source), path);
			assert.equal(source.slice(bodyStart, end), path === "" ? render(node, true) : render(node, true), `body of ${path}`);
			if (path !== "") assert.equal(source.slice(start, bodyStart), headerSection(node), `header of ${path}`);
			if (entry.inner) {
				assert.equal(source.slice(entry.inner[0], entry.inner[1]), expected(source, path, "header"));
				assert.equal(source.slice(entry.inner[1], entry.inner[2]), expected(source, path, "text"));
			}
		}
		assert.equal(source.slice(0, index.headerSize), headerSection(parseTree(source)));
	});
}

test("reviveLists restores the no-space-between-lists marker that JSON drops", () => {
	const index = indexMime(normalizeLineBreaks(crlf(mixed)));
	const revived = reviveLists(JSON.parse(JSON.stringify(index.bodystructure)));
	assert.equal(revived.adjacentLists, true, "a multipart's list of bodies");
	assert.equal(revived[0].adjacentLists, true, "the nested multipart");
	assert.equal(revived[0][0].adjacentLists, undefined, "a single part is not one");
	const addresses = reviveLists(JSON.parse(JSON.stringify(index.envelope)))[5];
	assert.equal(addresses.adjacentLists, true, "an envelope address list");
});

async function store(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sqlite = database.db;
	sqlite.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.test', 'x', 'U', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'me', 1);
	`);
	const bucketDirectory = mkdtempSync(join(directory, "bucket-"));
	const bucket = openFileBucket(bucketDirectory);
	const reads = [];
	const spyBucket = {
		get: (key, options) => { reads.push({ key, range: options?.range }); return bucket.get(key, options); },
		put: (...args) => bucket.put(...args),
		delete: (...args) => bucket.delete(...args),
		list: (...args) => bucket.list(...args),
		head: (...args) => bucket.head(...args),
	};
	const env = { DB: database, BUCKET: spyBucket, MAIL_HOSTNAME: "mail.example.test" };
	let counter = 0;
	const add = (overrides = {}) => {
		const id = overrides.id ?? `g${++counter}`;
		const row = { user_id: "u1", mailbox_id: "m1", direction: "inbound", from_addr: "a@b.test", to_addr: "me@example.test", status: "received", subject: "s", text_body: "t", html_body: null, created_at: 1000 + counter, ...overrides, id };
		const names = Object.keys(row);
		sqlite.prepare(`INSERT INTO messages (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
		return id;
	};
	const cache = (id) => sqlite.prepare("SELECT * FROM imap_message_cache WHERE message_id = ?").get(id);
	return { sqlite, env, bucket, reads, add, cache };
}

test("a stored CRLF message is served from its own object and indexed once", async (t) => {
	const { env, bucket, reads, add, cache, sqlite } = await store(t);
	const source = crlf(rfc822);
	await bucket.put("inbound/a.eml", source);
	const id = add({ raw_r2_key: "inbound/a.eml" });
	const index = await getMessageIndex(env, id);
	assert.equal(index.size, source.length);
	assert.equal(index.key, "inbound/a.eml");
	assert.equal(cache(id).synth_key, null, "nothing was copied");
	assert.equal(cache(id).size, source.length);
	reads.length = 0;
	const again = await getMessageIndex(env, id);
	assert.deepEqual(again.ranges, index.ranges);
	assert.deepEqual(again.envelope[1], "outer");
	assert.equal(reads.length, 0, "the second call is answered from the cache row");
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(id);
	assert.equal(cache(id), undefined, "the cache row goes with the message");
});

test("section reads fetch byte ranges, not the object", async (t) => {
	const { env, bucket, reads, add } = await store(t);
	const source = crlf(rfc822);
	await bucket.put("inbound/a.eml", source);
	const id = add({ raw_r2_key: "inbound/a.eml" });
	await getMessageIndex(env, id);
	reads.length = 0;
	const text = (result) => Buffer.from(result.data).toString("latin1");
	const tree = parseTree(source);
	assert.equal(text(await readSection(env, id, { part: "1", kind: "all" })), "first");
	assert.deepEqual(reads, [{ key: "inbound/a.eml", range: { offset: source.indexOf("first"), length: 5 } }]);
	assert.equal(text(await readSection(env, id, { part: "2", kind: "header" })), headerSection(resolveNode(tree, "2").message));
	assert.equal(text(await readSection(env, id, { part: "2", kind: "mime" })), "Content-Type: message/rfc822\r\n\r\n");
	assert.equal(text(await readSection(env, id, { part: "2.2", kind: "all" })), "<i>in-b</i>");
	assert.equal(text(await readSection(env, id, { part: "", kind: "header" })), headerSection(tree));
	assert.equal(text(await readSection(env, id, { part: "", kind: "all" })), source);
	const partial = await readSection(env, id, { part: "", kind: "all", partial: { offset: 5, length: 10 } });
	assert.equal(text(partial), source.slice(5, 15));
	assert.equal(partial.total, source.length);
	assert.deepEqual((await readSection(env, id, { part: "", kind: "all", partial: { offset: source.length + 50, length: 10 } })).data.length, 0);
	assert.equal(await readSection(env, id, { part: "9", kind: "all" }), null);
	assert.equal(await readSection(env, id, { part: "1", kind: "header" }), null, "HEADER needs a message/rfc822 part");
	assert.equal(await readSection(env, id, { part: "", kind: "mime" }), null);
	assert.equal(await readSection(env, "nope", { part: "", kind: "all" }), null);
	assert.ok(reads.every((read) => read.range), "every read was ranged");
});

test("HEADER.FIELDS and HEADER.FIELDS.NOT filter whole folded fields", async (t) => {
	const { env, bucket, add } = await store(t);
	await bucket.put("inbound/h.eml", crlf(["Subject: one", " continued", "From: a@x.test", "X-Other: y", "", "body"]));
	const id = add({ raw_r2_key: "inbound/h.eml" });
	const text = (result) => Buffer.from(result.data).toString("latin1");
	assert.equal(text(await readSection(env, id, { part: "", kind: "header.fields", fields: ["SUBJECT", "x-missing"] })), "Subject: one\r\n continued\r\n\r\n");
	assert.equal(text(await readSection(env, id, { part: "", kind: "header.fields.not", fields: ["subject"] })), "From: a@x.test\r\nX-Other: y\r\n\r\n");
	assert.equal(text(await readSection(env, id, { part: "", kind: "header.fields", fields: [] })), "\r\n");
});

test("a stored message with bare line breaks is served as a CRLF copy under imap-cache/", async (t) => {
	const { env, bucket, add, cache } = await store(t);
	await bucket.put("inbound/lf.eml", "Subject: lf\n\nline one\nline two\n");
	const id = add({ raw_r2_key: "inbound/lf.eml" });
	const index = await getMessageIndex(env, id);
	assert.match(index.key, new RegExp(`^imap-cache/${id}/[0-9a-f]{32}\\.eml$`), "the key carries the hash of the bytes");
	assert.equal(cache(id).synth_key, index.key);
	const whole = await readSection(env, id, { part: "", kind: "all" });
	assert.equal(Buffer.from(whole.data).toString("latin1"), "Subject: lf\r\n\r\nline one\r\nline two\r\n");
	assert.equal(index.size, whole.data.length, "RFC822.SIZE is the size of the bytes served");
	assert.equal(await (await bucket.get("inbound/lf.eml")).text(), "Subject: lf\n\nline one\nline two\n", "the stored message is untouched");
});

test("a row without raw bytes is synthesized once, with its attachments, and parses", async (t) => {
	const { env, bucket, add, cache, sqlite } = await store(t);
	await bucket.put("att/one", "attached bytes");
	const id = add({ direction: "outbound", status: "sent", subject: "Sent mail", text_body: "body text", html_body: "<p>body</p>", from_addr: "me@example.test", to_addr: "to@x.test" });
	sqlite.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES ('at1', ?, 'a.txt', 'text/plain', 14, 'attachment', 'att/one', 1)").run(id);
	sqlite.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at, trashed_at) VALUES ('at2', ?, 'gone.txt', 'text/plain', 1, 'attachment', 'att/two', 2, 5)").run(id);
	const index = await getMessageIndex(env, id);
	assert.match(index.key, new RegExp(`^imap-cache/${id}/[0-9a-f]{32}\\.eml$`));
	const bytes = Buffer.from((await readSection(env, id, { part: "", kind: "all" })).data);
	assert.equal(bytes.length, index.size);
	const parsed = await PostalMime.parse(bytes);
	assert.equal(parsed.subject, "Sent mail");
	assert.equal(parsed.attachments.length, 1, "a trashed attachment is not part of the message");
	assert.equal(new TextDecoder().decode(parsed.attachments[0].content), "attached bytes");
	assert.equal(index.envelope[1], "Sent mail");
	assert.match(index.envelope[9], /^<g\d+@mail\.example\.test>$/);
	sqlite.prepare("UPDATE messages SET provider_message_id = '<later@x>' WHERE id = ?").run(id);
	assert.deepEqual((await getMessageIndex(env, id)).envelope, index.envelope, "the cached bytes stay stable when the row changes");
	assert.equal(cache(id).size, index.size);
});

test("a missing attachment object leaves an empty part instead of failing the fetch", async (t) => {
	const { env, add, sqlite } = await store(t);
	const id = add({ direction: "outbound", status: "sent" });
	sqlite.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES ('at1', ?, 'lost.bin', 'application/octet-stream', 9, 'attachment', 'att/lost', 1)").run(id);
	const bytes = Buffer.from((await readSection(env, id, { part: "", kind: "all" })).data);
	const parsed = await PostalMime.parse(bytes);
	assert.equal(parsed.attachments[0].filename, "lost.bin");
	assert.equal(parsed.attachments[0].content.byteLength, 0);
});

test("a raw key whose object is gone falls back to synthesis", async (t) => {
	const { env, add } = await store(t);
	const id = add({ raw_r2_key: "inbound/purged.eml", subject: "still here" });
	const index = await getMessageIndex(env, id);
	assert.equal(index.envelope[1], "still here");
	assert.match(index.key, new RegExp(`^imap-cache/${id}/`));
});

test("a draft edited after the first fetch gets new bytes once the sync drops its cache", async (t) => {
	const { env, add, sqlite, cache } = await store(t);
	const id = add({ direction: "outbound", status: "draft", subject: "v1", text_body: "first version" });
	await syncMailbox(env, "m1");
	assert.equal((await getMessageIndex(env, id)).envelope[1], "v1");
	sqlite.prepare("UPDATE messages SET subject = 'v2', text_body = 'second version' WHERE id = ?").run(id);
	await syncMailbox(env, "m1");
	assert.equal(cache(id), undefined, "F8-1's sync dropped the stale row");
	const next = await getMessageIndex(env, id);
	assert.equal(next.envelope[1], "v2");
	assert.match(Buffer.from((await readSection(env, id, { part: "1", kind: "all" })).data).toString("latin1"), /^[A-Za-z0-9+/=\r\n]+$/);
	const decoded = Buffer.from(Buffer.from((await readSection(env, id, { part: "1", kind: "all" })).data).toString("latin1"), "base64").toString();
	assert.equal(decoded, "second version");
});

test("an edit that lands while a draft is being indexed is not cached under the old bytes", async (t) => {
	const { env, add, sqlite, cache } = await store(t);
	const id = add({ direction: "outbound", status: "draft", subject: "old", text_body: "x" });
	const put = env.BUCKET.put;
	let raced = false;
	env.BUCKET.put = async (...args) => {
		if (!raced) {
			raced = true;
			sqlite.prepare("UPDATE messages SET subject = 'new' WHERE id = ?").run(id);
		}
		return put(...args);
	};
	const index = await getMessageIndex(env, id);
	assert.equal(index.envelope[1], "new");
	assert.equal(JSON.parse(cache(id).envelope)[1], "new");
});
test("a draft is served from its columns even when it carries stored raw bytes", async (t) => {
	const { env, bucket, add, cache } = await store(t);
	await bucket.put("inbound/draft.eml", crlf(["From: a@b.test", "Subject: stale subject", "", "stale body"]));
	const id = add({ direction: "outbound", status: "draft", raw_r2_key: "inbound/draft.eml", subject: "edited subject", text_body: "edited body" });
	const index = await getMessageIndex(env, id);
	assert.equal(index.envelope[1], "edited subject");
	assert.match(index.key, new RegExp(`^imap-cache/${id}/`));
	assert.equal(cache(id).synth_key, index.key);
	const sent = add({ direction: "inbound", status: "received", raw_r2_key: "inbound/draft.eml", subject: "column subject" });
	assert.equal((await getMessageIndex(env, sent)).envelope[1], "stale subject", "any other row is still served from its raw bytes");
});

test("a row that is still being sent is not cached, so its Message-ID can change", async (t) => {
	const { env, add, cache, sqlite } = await store(t);
	for (const status of ["queued", "scheduled"]) {
		const id = add({ direction: "outbound", status, subject: status });
		const queued = await getMessageIndex(env, id);
		assert.equal(cache(id), undefined, `${status}: no cache row`);
		assert.match(queued.envelope[9], /^<g\d+@mail\.example\.test>$/);
		const text = Buffer.from((await readSection(env, id, { part: "", kind: "header" })).data).toString("latin1");
		assert.match(text, /^Message-ID: <g\d+@mail\.example\.test>\r$/m, "its bytes can still be read");
		sqlite.prepare("UPDATE messages SET status = 'sent', provider_message_id = '<ses-1@x.test>' WHERE id = ?").run(id);
		assert.equal((await getMessageIndex(env, id)).envelope[9], "<ses-1@x.test>", "the next read sees the provider's id");
		assert.ok(cache(id), "and a sent row is cached");
	}
});

test("a synthesized object is keyed by its bytes, so an edit never overwrites what was served", async (t) => {
	const { env, bucket, add, sqlite } = await store(t);
	const id = add({ direction: "outbound", status: "draft", subject: "v1", text_body: "first" });
	const first = await getMessageIndex(env, id);
	const firstBytes = await (await bucket.get(first.key)).text();
	sqlite.prepare("DELETE FROM imap_message_cache WHERE message_id = ?").run(id);
	sqlite.prepare("UPDATE messages SET subject = 'v2' WHERE id = ?").run(id);
	const second = await getMessageIndex(env, id);
	assert.notEqual(second.key, first.key);
	assert.equal(await (await bucket.get(first.key)).text(), firstBytes, "the earlier object is untouched");
	assert.equal(cacheKey(id, "abc"), `imap-cache/${id}/abc.eml`);
});

test("a message the indexer refuses is recorded and not parsed again until it changes", async (t) => {
	const { env, add, cache, sqlite } = await store(t);
	const id = add({ subject: "odd" });
	let calls = 0;
	const refuse = () => { calls += 1; throw new RangeError("too much"); };
	await assert.rejects(() => getMessageIndex(env, id, refuse), (error) => error instanceof MimeIndexError && /RangeError/.test(error.message), "any failure becomes a MimeIndexError");
	assert.equal(calls, 1);
	assert.equal(cache(id).size, -1);
	assert.match(JSON.parse(cache(id).envelope).unindexable, /too much/);
	await assert.rejects(() => getMessageIndex(env, id, refuse), MimeIndexError);
	assert.equal(calls, 1, "the second read is answered from the recorded outcome");
	sqlite.prepare("UPDATE messages SET subject = 'changed' WHERE id = ?").run(id);
	assert.equal((await getMessageIndex(env, id)).envelope[1], "changed", "an edit makes the message worth another try");
	assert.ok(cache(id).size > 0);
});

test("any failure of the indexer is a MimeIndexError", () => {
	for (const input of [undefined, null, 5, {}]) assert.throws(() => indexMime(input), MimeIndexError);
});

test("deep nesting is indexed as a leaf and a very wide multipart is capped", () => {
	const deep = indexMime(nest(8000));
	assert.ok(Object.keys(deep.ranges).length < 100);
	assert.ok(JSON.stringify(deep.bodystructure).length < 100_000);
	let wide = "Content-Type: multipart/mixed; boundary=b\r\n\r\n";
	for (let part = 0; part < 5000; part += 1) wide += `--b\r\n\r\nx\r\n`;
	const index = indexMime(`${wide}--b--\r\n`);
	assert.ok(Object.keys(index.ranges).length <= 1001);
});

test("a message with an oversized address field is indexed with NIL for that field", () => {
	const source = `From: ${"a.".repeat(20000)}@x.test\r\nTo: ok@x.test\r\nSubject: s\r\n\r\nbody`;
	const index = indexMime(source);
	assert.equal(index.envelope[2], null);
	assert.equal(index.envelope[5][0][2], "ok");
});

test("a missing raw object of an inbound message is logged once", async (t) => {
	const { env, add } = await store(t);
	const warn = mock.method(console, "warn", () => {});
	t.after(() => warn.mock.restore());
	const id = add({ raw_r2_key: "inbound/purged-2.eml" });
	await getMessageIndex(env, id);
	await getMessageIndex(env, id);
	assert.equal(warn.mock.calls.length, 1);
	assert.match(String(warn.mock.calls[0].arguments[0]), /inbound\/purged-2\.eml/);
});

test("a ranged read of a file bucket object reads only the range", async (t) => {
	const { bucket } = await store(t);
	const data = Buffer.alloc(5000, "a");
	data.write("RANGE", 1234);
	await bucket.put("big/object", data);
	const original = fsPromises.readFile;
	const wholeFileReads = [];
	fsPromises.readFile = async (path, ...rest) => { if (!String(path).endsWith(".meta.json")) wholeFileReads.push(String(path)); return original(path, ...rest); };
	syncBuiltinESMExports();
	t.after(() => { fsPromises.readFile = original; syncBuiltinESMExports(); });
	const read = async (range) => Buffer.from(await (await bucket.get("big/object", { range })).arrayBuffer()).toString("latin1");
	assert.equal(await read({ offset: 1234, length: 5 }), "RANGE");
	assert.equal(await read({ offset: 4990, length: 100 }), "a".repeat(10), "a range past the end is cut");
	assert.equal(await read({ offset: 6000, length: 10 }), "");
	assert.equal((await read({ suffix: 3 })).length, 3);
	assert.deepEqual(wholeFileReads, [], "the object was not read whole");
	assert.equal((await (await bucket.get("big/object")).arrayBuffer()).byteLength, 5000);
	assert.equal(wholeFileReads.length, 1, "an unranged read still reads the file");
});
