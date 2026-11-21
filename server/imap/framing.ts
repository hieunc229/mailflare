/**
 * Splits the byte stream of one IMAP connection into commands: a CRLF line, plus,
 * for every `{n}` / `{n+}` at the end of a line, exactly `n` literal bytes and the
 * rest of the command on the next line. The result is the whole command as one
 * binary string (one character per octet), the form `imap-handler` parses.
 *
 * Everything an unauthenticated client controls is bounded here, before any
 * parsing: the longest line, the largest literal, the size of a whole command, and
 * the number of lines waiting. A line that is too long, a non-synchronising literal
 * over the limit and a command over the limit end the connection (the bytes are
 * never read); a synchronising literal over the limit is refused before the
 * continuation is sent, so the client does not send it and the connection goes on.
 *
 * The framer is pulled, one event at a time, so the connection runs one command at
 * a time and a continuation request (`+`) is only ever written between two commands.
 */
export type FrameLimits = { maxLine: number; maxLiteral: number; maxCommand: number };

/** Before login only LOGIN and AUTHENTICATE are useful: a password and a SASL response are small. */
export const PRE_AUTH_LIMITS: FrameLimits = { maxLine: 8 * 1024, maxLiteral: 4 * 1024, maxCommand: 16 * 1024 };
/** After login: RFC 3501 only asks for 8 KiB lines, search strings and header lists can be longer; APPEND (its own, larger literal) comes with the write commands. */
export const AUTH_LIMITS: FrameLimits = { maxLine: 64 * 1024, maxLiteral: 64 * 1024, maxCommand: 256 * 1024 };
/** Complete lines the client may have sent ahead of the one being run. */
export const MAX_PENDING_LINES = 1000;

export type FrameEvent =
	| { type: "command"; text: string }
	| { type: "continue" }
	| { type: "reject"; code: "line" | "literal" | "command"; tag: string; close: boolean };

type State = "line" | "await-continue" | "literal";

const INITIAL_CAPACITY = 4096;
/** One TLS record: a read from the socket can bring this much beyond what the limits allow to wait. */
const TLS_RECORD = 16 * 1024;
const LF = 10;
const CR = 13;
const LITERAL_AT_END = /\{(\d{1,10})(\+?)\}$/;
const MAX_LITERAL_SIZE = 4294967295;
const TAG = /^[A-Za-z0-9._~!$&'*,;<=>?@^|-]{1,64}(?= |$)/;

/** The tag of a command, or `*` when it has none a server may repeat. */
export function tagOf(text: string): string {
	return text.match(TAG)?.[0] ?? "*";
}

export class Framer {
	limits: FrameLimits;
	private buffer = Buffer.allocUnsafe(INITIAL_CAPACITY);
	private start = 0;
	private end = 0;
	private scanned = 0;
	private lines = 0;
	private state: State = "line";
	private parts: string[] = [];
	private total = 0;
	private literalNeed = 0;
	private literalChunks: Buffer[] = [];
	/** Set when more complete lines wait than `MAX_PENDING_LINES`; the connection is then closed. */
	overflowed = false;

	constructor(limits: FrameLimits) {
		this.limits = limits;
	}

	/** Bytes received and not yet turned into events. */
	get buffered(): number {
		return this.end - this.start;
	}

	/** Bytes the buffer can hold without growing; it returns to its small size whenever less than that is left unread. */
	get capacity(): number {
		return this.buffer.length;
	}

	/** How much input may wait before the socket should stop reading: one whole command and one more line. */
	get backlogLimit(): number {
		return this.limits.maxCommand + this.limits.maxLine;
	}

	/** Forget everything received so far (after STARTTLS, so nothing sent in the clear is ever interpreted). */
	clear(): void {
		this.buffer = Buffer.allocUnsafe(INITIAL_CAPACITY);
		this.start = this.end = this.scanned = this.lines = 0;
		this.state = "line";
		this.parts = [];
		this.total = 0;
		this.literalNeed = 0;
		this.literalChunks = [];
	}

	push(chunk: Buffer): void {
		let data: Buffer = chunk;
		// Literal bytes go straight to their command, so they neither fill the buffer nor count as lines.
		if (this.state === "literal" && this.literalNeed > 0 && this.buffered === 0) {
			const take = Math.min(this.literalNeed, data.length);
			this.literalChunks.push(Buffer.from(data.subarray(0, take)));
			this.literalNeed -= take;
			data = data.subarray(take) as Buffer;
		}
		if (!data.length) return;
		if (this.end + data.length > this.buffer.length) {
			const live = this.buffered;
			// Doubling stops at one command, one more line and one TLS record; only a chunk that does not fit is allowed past it.
			const ceiling = this.backlogLimit + TLS_RECORD;
			const next = live + data.length > this.buffer.length / 2 ? Buffer.allocUnsafe(Math.max(Math.min(this.buffer.length * 2, ceiling), live + data.length)) : this.buffer;
			next.set(this.buffer.subarray(this.start, this.end), 0);
			this.buffer = next;
			this.scanned -= this.start;
			this.start = 0;
			this.end = live;
		}
		this.buffer.set(data, this.end);
		this.end += data.length;
		for (const byte of data) if (byte === LF) this.lines += 1;
		if (this.state === "line" && this.lines > MAX_PENDING_LINES) this.overflowed = true;
	}

	private consume(length: number): Buffer {
		const taken = this.buffer.subarray(this.start, this.start + length) as Buffer;
		for (const byte of taken) if (byte === LF) this.lines -= 1;
		this.start += length;
		this.scanned = Math.max(this.scanned, this.start);
		// `taken` keeps the old memory alive for the caller; the framer itself goes back to a small buffer
		// whenever what is left unread fits in one.
		const rest = this.end - this.start;
		if (rest < INITIAL_CAPACITY && this.buffer.length > INITIAL_CAPACITY) {
			const small = Buffer.allocUnsafe(INITIAL_CAPACITY);
			small.set(this.buffer.subarray(this.start, this.end), 0);
			this.scanned -= this.start;
			this.buffer = small;
			this.start = 0;
			this.end = rest;
		}
		return taken;
	}

	private reset(): void {
		this.parts = [];
		this.total = 0;
		this.literalChunks = [];
		this.literalNeed = 0;
		this.state = "line";
	}

	private reject(code: "line" | "literal" | "command", close: boolean, line: string): FrameEvent {
		const tag = tagOf(this.parts[0] ?? line);
		this.reset();
		return { type: "reject", code, tag, close };
	}

	next(): FrameEvent | null {
		for (;;) {
			if (this.state === "await-continue") {
				this.state = "literal";
				return { type: "continue" };
			}
			if (this.state === "literal") {
				const take = Math.min(this.literalNeed, this.buffered);
				if (take) {
					this.literalChunks.push(Buffer.from(this.consume(take)));
					this.literalNeed -= take;
				}
				if (this.literalNeed > 0) return null;
				this.parts.push(Buffer.concat(this.literalChunks).toString("latin1"));
				this.literalChunks = [];
				this.state = "line";
				continue;
			}
			const at = this.buffer.indexOf(LF, Math.max(this.scanned, this.start));
			if (at < 0 || at >= this.end) {
				this.scanned = this.end;
				// One more byte may be the CR of a line that is exactly at the limit.
				if (this.buffered > this.limits.maxLine + 1) return this.reject("line", true, Buffer.from(this.buffer.buffer, this.buffer.byteOffset + this.start, Math.min(this.end - this.start, 80)).toString("latin1"));
				return null;
			}
			const length = at - this.start;
			const raw = this.consume(length + 1);
			const lineLength = raw[length - 1] === CR && length > 0 ? length - 1 : length;
			const line = Buffer.from(raw.buffer, raw.byteOffset, lineLength).toString("latin1");
			if (line.length > this.limits.maxLine) return this.reject("line", true, line);
			this.total += line.length;
			if (this.total > this.limits.maxCommand) return this.reject("command", true, line);
			const literal = LITERAL_AT_END.exec(line);
			const size = literal ? Number(literal[1]) : 0;
			if (!literal || size > MAX_LITERAL_SIZE) {
				const text = this.parts.join("") + line;
				this.reset();
				return { type: "command", text };
			}
			const synchronising = literal[2] === "";
			if (size > this.limits.maxLiteral) return this.reject("literal", !synchronising, line);
			this.total += size + 2;
			if (this.total > this.limits.maxCommand) return this.reject("command", true, line);
			this.parts.push(`${line}\r\n`);
			this.literalNeed = size;
			this.state = synchronising ? "await-continue" : "literal";
		}
	}
}
