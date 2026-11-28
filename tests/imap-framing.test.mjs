import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-framing-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: { contents: `export { Framer, PRE_AUTH_LIMITS, AUTH_LIMITS, MAX_PENDING_LINES } from "./server/imap/framing.ts";`, resolveDir: root, sourcefile: "imap-framing-entry.ts" },
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { Framer, PRE_AUTH_LIMITS, AUTH_LIMITS, MAX_PENDING_LINES } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const drain = (framer) => {
	const events = [];
	for (let event = framer.next(); event; event = framer.next()) {
		events.push(event);
		if (event.type === "reject" && event.close) break;
	}
	return events;
};
const limits = { maxLine: 64, maxLiteral: 16, maxCommand: 100 };

test("a command is one CRLF line, delivered once it is complete", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a1 NOOP"));
	assert.deepEqual(drain(framer), []);
	framer.push(Buffer.from("\r\na2 CAPABILITY\r\n"));
	assert.deepEqual(drain(framer), [{ type: "command", text: "a1 NOOP" }, { type: "command", text: "a2 CAPABILITY" }]);
});

test("a bare LF ends a line too, and a lone CR does not", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a1 NOOP\na2 X\rY\r\n"));
	assert.deepEqual(drain(framer), [{ type: "command", text: "a1 NOOP" }, { type: "command", text: "a2 X\rY" }]);
});

test("a synchronising literal waits for the continuation and joins the command", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a1 LOGIN {3}\r\n"));
	assert.deepEqual(drain(framer), [{ type: "continue" }]);
	framer.push(Buffer.from("abc \"x\"\r\nb NOOP\r\n"));
	assert.deepEqual(drain(framer), [{ type: "command", text: 'a1 LOGIN {3}\r\nabc "x"' }, { type: "command", text: "b NOOP" }]);
});

test("a literal is not looked at for line ends and may hold CRLF", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a1 SEARCH TEXT {6+}\r\nab\r\ncd\r\n"));
	assert.deepEqual(drain(framer), [{ type: "command", text: "a1 SEARCH TEXT {6+}\r\nab\r\ncd" }]);
});

test("literal bytes may arrive one at a time", () => {
	const framer = new Framer(limits);
	const wire = Buffer.from("a1 LOGIN {4+}\r\nabcd {2+}\r\nxy\r\n");
	const events = [];
	for (const byte of wire) {
		framer.push(Buffer.from([byte]));
		events.push(...drain(framer));
	}
	assert.deepEqual(events, [{ type: "command", text: "a1 LOGIN {4+}\r\nabcd {2+}\r\nxy" }]);
});

test("a line over the limit is refused and the connection is closed", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from(`a1 ${"x".repeat(70)}`));
	assert.deepEqual(drain(framer), [{ type: "reject", code: "line", tag: "a1", close: true }]);
});

test("a line that is long but ends in time is accepted at the limit and refused one over", () => {
	const ok = new Framer(limits);
	ok.push(Buffer.from(`${"y".repeat(62)}\r\n`));
	assert.equal(drain(ok)[0].type, "command");
	const over = new Framer(limits);
	over.push(Buffer.from(`${"y".repeat(65)}\r\n`));
	assert.equal(drain(over)[0].type, "reject");
});

test("a synchronising literal over the limit is refused without a continuation, and the next command still works", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a1 LOGIN {17}\r\na2 NOOP\r\n"));
	assert.deepEqual(drain(framer), [{ type: "reject", code: "literal", tag: "a1", close: false }, { type: "command", text: "a2 NOOP" }]);
});

test("a non-synchronising literal over the limit closes the connection instead of reading it", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a1 LOGIN {4294967295+}\r\n"));
	assert.deepEqual(drain(framer), [{ type: "reject", code: "literal", tag: "a1", close: true }]);
});

test("a literal size that is not a plain number is part of the line, not a literal", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a1 X {99999999999999999999}\r\n"));
	assert.deepEqual(drain(framer), [{ type: "command", text: "a1 X {99999999999999999999}" }]);
});

test("a command made of many literals is cut off at the command limit", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from(`a1 X ${"{16+}\r\n0123456789abcdef ".repeat(8)}\r\n`));
	const events = drain(framer);
	assert.deepEqual(events.at(-1), { type: "reject", code: "command", tag: "a1", close: true });
});

test("a refused command with an unusable tag is answered with *", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from(`"quoted" ${"x".repeat(70)}`));
	assert.equal(drain(framer)[0].tag, "*");
});

test("limits can be raised after login and apply to the next line", () => {
	const framer = new Framer(PRE_AUTH_LIMITS);
	framer.push(Buffer.from(`a1 X ${"z".repeat(PRE_AUTH_LIMITS.maxLine)}\r\n`));
	assert.equal(drain(framer)[0].code, "line");
	const later = new Framer(PRE_AUTH_LIMITS);
	later.limits = AUTH_LIMITS;
	later.push(Buffer.from(`a1 X ${"z".repeat(PRE_AUTH_LIMITS.maxLine)}\r\n`));
	assert.equal(drain(later)[0].type, "command");
	assert.ok(PRE_AUTH_LIMITS.maxLine < AUTH_LIMITS.maxLine && PRE_AUTH_LIMITS.maxLiteral < AUTH_LIMITS.maxLiteral);
});

test("more pipelined lines than the queue allows is refused", () => {
	const framer = new Framer({ maxLine: 64, maxLiteral: 16, maxCommand: 100 });
	framer.push(Buffer.from("a NOOP\r\n".repeat(MAX_PENDING_LINES)));
	assert.equal(framer.overflowed, false);
	framer.push(Buffer.from("a NOOP\r\n"));
	assert.equal(framer.overflowed, true);
	const consumed = new Framer(limits);
	consumed.push(Buffer.from("a NOOP\r\n".repeat(MAX_PENDING_LINES)));
	drain(consumed);
	consumed.push(Buffer.from("a NOOP\r\n".repeat(MAX_PENDING_LINES)));
	assert.equal(consumed.overflowed, false, "processed lines no longer count");
});

test("buffered input stays small for a slow consumer: only what has not been read counts", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a NOOP\r\n"));
	assert.equal(framer.buffered, 8);
	drain(framer);
	assert.equal(framer.buffered, 0);
});

test("discarding what was buffered after STARTTLS leaves nothing behind", () => {
	const framer = new Framer(limits);
	framer.push(Buffer.from("a1 STARTTLS\r\nb1 LOGIN x y\r\n"));
	assert.equal(framer.next().text, "a1 STARTTLS");
	assert.equal(framer.buffered > 0, true);
	framer.clear();
	assert.equal(framer.buffered, 0);
	assert.equal(framer.next(), null);
});

test("the buffer goes back to its small size once everything has been read", () => {
	const framer = new Framer(AUTH_LIMITS);
	const line = `a1 X ${"z".repeat(60 * 1024)}\r\n`;
	framer.push(Buffer.from(line.repeat(4)));
	assert.ok(framer.capacity >= 4 * line.length, "it grew to hold the burst");
	assert.equal(drain(framer).length, 4);
	assert.equal(framer.buffered, 0);
	assert.ok(framer.capacity <= 4096, `capacity after the burst: ${framer.capacity}`);
	framer.push(Buffer.from("a2 NOOP\r\n"));
	assert.deepEqual(drain(framer), [{ type: "command", text: "a2 NOOP" }], "and it still works afterwards");
});

test("before login the buffer never grows past one command, one line and a TLS record", () => {
	const framer = new Framer(PRE_AUTH_LIMITS);
	const stream = Buffer.from(`a NOOP ${"x".repeat(7000)}\r\n`.repeat(140));
	let peak = 0;
	let commands = 0;
	// Like the connection: TLS records of 16 KiB keep arriving until more than the backlog is waiting, then the reader catches up.
	for (let at = 0; at < stream.length; at += 16 * 1024) {
		framer.push(stream.subarray(at, at + 16 * 1024));
		peak = Math.max(peak, framer.capacity);
		if (framer.buffered > framer.backlogLimit) commands += drain(framer).length;
	}
	commands += drain(framer).length;
	assert.equal(commands, 140);
	assert.ok(peak <= 48 * 1024, `peak capacity ${peak}`);
	assert.ok(framer.capacity <= 4096, `capacity at the end ${framer.capacity}`);
});

test("the buffer shrinks as soon as less than its small size is left unread, not only when empty", () => {
	const framer = new Framer(AUTH_LIMITS);
	const line = `a1 X ${"z".repeat(30 * 1024)}\r\n`;
	framer.push(Buffer.from(line.repeat(3) + "a2 NOO"));
	assert.ok(framer.capacity > 4096);
	assert.equal(framer.next().type, "command");
	assert.equal(framer.next().type, "command");
	assert.equal(framer.next().type, "command");
	assert.equal(framer.buffered, 6);
	assert.ok(framer.capacity <= 4096, `capacity with a partial line left: ${framer.capacity}`);
	framer.push(Buffer.from("P\r\n"));
	assert.deepEqual(drain(framer), [{ type: "command", text: "a2 NOOP" }]);
});

test("a connection is paused once about one command and one line are waiting", () => {
	assert.equal(new Framer(PRE_AUTH_LIMITS).backlogLimit, PRE_AUTH_LIMITS.maxCommand + PRE_AUTH_LIMITS.maxLine);
	assert.equal(new Framer(AUTH_LIMITS).backlogLimit, AUTH_LIMITS.maxCommand + AUTH_LIMITS.maxLine);
	const framer = new Framer(PRE_AUTH_LIMITS);
	framer.limits = AUTH_LIMITS;
	assert.equal(framer.backlogLimit, AUTH_LIMITS.maxCommand + AUTH_LIMITS.maxLine, "it follows the limits raised at login");
});

// ---- APPEND ----

const appendLimits = { maxLine: 64, maxLiteral: 16, maxCommand: 100, maxAppend: 1000 };
const budget = (total) => {
	const state = { used: 0 };
	return { state, reserve: (n) => (state.used + n <= total ? ((state.used += n), true) : false), release: (n) => { state.used -= n; } };
};
const framerFor = (limits, pool) => {
	const framer = new Framer(limits);
	framer.reserve = pool.reserve;
	framer.release = pool.release;
	return framer;
};

test("an APPEND message literal bigger than any other literal is handed over as its own buffer", () => {
	const pool = budget(5000);
	const framer = framerFor(appendLimits, pool);
	framer.push(Buffer.from("a1 APPEND INBOX (\\Seen) {500}\r\n"));
	assert.deepEqual(drain(framer), [{ type: "continue" }]);
	assert.equal(pool.state.used, 500);
	const message = Buffer.alloc(500, "m");
	message.write("\r\n", 10);
	framer.push(Buffer.concat([message, Buffer.from("\r\nb1 NOOP\r\n")]));
	const [command, next] = drain(framer);
	assert.equal(command.text, 'a1 APPEND INBOX (\\Seen) ""');
	assert.deepEqual([command.body.equals(message), command.reserved], [true, 500]);
	assert.deepEqual(next, { type: "command", text: "b1 NOOP" });
	assert.equal(pool.state.used, 500, "the connection gives the reservation back when the command is done");
});

test("an APPEND literal over the limit is refused before the continuation (synchronising) and nothing is held", () => {
	const pool = budget(5000);
	const framer = framerFor(appendLimits, pool);
	framer.push(Buffer.from('a1 APPEND "My Folder" {1001}\r\nb1 NOOP\r\n'));
	assert.deepEqual(drain(framer), [{ type: "reject", code: "append-size", tag: "a1", close: false }, { type: "command", text: "b1 NOOP" }]);
	assert.equal(pool.state.used, 0);
});

test("a non-synchronising APPEND literal over the limit is discarded as it arrives, the line after it too, and the connection goes on", () => {
	const pool = budget(5000);
	const framer = framerFor(appendLimits, pool);
	framer.push(Buffer.from("a1 APPEND INBOX {200000+}\r\n"));
	const events = drain(framer);
	assert.deepEqual(events, [{ type: "reject", code: "append-size", tag: "a1", close: false }]);
	for (let sent = 0; sent < 200000; sent += 8192) {
		framer.push(Buffer.alloc(Math.min(8192, 200000 - sent), "x"));
		assert.deepEqual(drain(framer), []);
		assert.equal(framer.buffered, 0, "nothing of it is kept");
	}
	assert.ok(framer.capacity <= 4096 * 4, `buffer stayed small (${framer.capacity})`);
	framer.push(Buffer.from("\r\nb1 NOOP\r\n"));
	assert.deepEqual(drain(framer), [{ type: "command", text: "b1 NOOP" }]);
});

test("a discarded literal that arrives in one push with the commands after it also works", () => {
	const framer = framerFor(appendLimits, budget(5000));
	framer.push(Buffer.from(`a1 APPEND INBOX {3000+}\r\n${"x".repeat(3000)}\r\nb1 NOOP\r\n`));
	assert.deepEqual(drain(framer), [{ type: "reject", code: "append-size", tag: "a1", close: false }, { type: "command", text: "b1 NOOP" }]);
});

test("when the budget of in-flight APPEND data is spent the literal is refused as busy, and given back when the framer is disposed", () => {
	const pool = budget(600);
	const first = framerFor(appendLimits, pool);
	first.push(Buffer.from("a1 APPEND INBOX {500}\r\n"));
	assert.deepEqual(drain(first), [{ type: "continue" }]);
	const second = framerFor(appendLimits, pool);
	second.push(Buffer.from("b1 APPEND INBOX {500+}\r\n"));
	assert.deepEqual(drain(second), [{ type: "reject", code: "append-busy", tag: "b1", close: false }]);
	first.dispose();
	assert.equal(pool.state.used, 0);
});

test("a mailbox name sent as a literal, other commands and a framer without maxAppend keep the ordinary literal limit", () => {
	const pool = budget(5000);
	const framer = framerFor(appendLimits, pool);
	framer.push(Buffer.from("a1 APPEND {5}\r\nINBOX {500}\r\n"));
	assert.deepEqual(drain(framer).map((event) => event.type), ["continue", "reject"]);
	const other = framerFor(appendLimits, pool);
	other.push(Buffer.from("a2 SEARCH TEXT {500+}\r\n"));
	assert.deepEqual(drain(other), [{ type: "reject", code: "literal", tag: "a2", close: true }]);
	const plain = framerFor(limits, pool);
	plain.push(Buffer.from("a3 APPEND INBOX {500+}\r\n"));
	assert.deepEqual(drain(plain), [{ type: "reject", code: "literal", tag: "a3", close: true }]);
	assert.equal(pool.state.used, 0);
});

test("an APPEND literal does not count against the command size, and an unterminated line after a refused literal ends the connection", () => {
	const framer = framerFor({ ...appendLimits, maxCommand: 100 }, budget(5000));
	framer.push(Buffer.from(`a1 APPEND INBOX {900+}\r\n${"m".repeat(900)}\r\n`));
	const [command] = drain(framer);
	assert.equal(command.body.length, 900);
	const refused = framerFor(appendLimits, budget(5000));
	refused.push(Buffer.from(`a1 APPEND INBOX {2000+}\r\n${"x".repeat(2000)}${"y".repeat(200)}`));
	const events = drain(refused);
	assert.deepEqual(events.map((event) => [event.type, event.code, event.close]), [["reject", "append-size", false], ["reject", "line", true]]);
});
