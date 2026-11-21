import assert from "node:assert/strict";
import test from "node:test";
import bodystructure from "../server/imap/vendor/imapkit/bodystructure.js";
import envelope from "../server/imap/vendor/imapkit/envelope.js";
import addressparser from "../server/imap/vendor/imapkit/addressparser.js";
import { normalizeLineBreaks, parseTree, render } from "../server/imap/vendor/imapkit/mimeparser.js";

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
