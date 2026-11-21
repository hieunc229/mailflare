import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import PostalMime from "postal-mime";
import bodystructure from "../server/imap/vendor/imapkit/bodystructure.js";
import envelope from "../server/imap/vendor/imapkit/envelope.js";
import addressparser from "../server/imap/vendor/imapkit/addressparser.js";
import { normalizeLineBreaks, parseTree, render } from "../server/imap/vendor/imapkit/mimeparser.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-mime-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { synthesizeMessage } from "./src/lib/imap/synthesize.ts";
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
const { synthesizeMessage } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

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
