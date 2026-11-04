import type { ImportMessageInput } from "./types";
import type { ImapImportInput } from "./imap-types";
import {
	assertSafeImapHost,
	getLiteralLength,
	planImapFetchGroups,
	isTaggedCompletion,
	parseFetchFlags,
	parseListMailboxName,
	parseSearchUids,
	quoteImapString,
	selectImapUidBatch,
} from "./imap-utils";

type CloudflareSocketConnect = (
	address: { hostname: string; port: number },
	options: { secureTransport: "on" | "off"; allowHalfOpen: boolean },
) => Socket;

async function getCloudflareSocketConnect(): Promise<CloudflareSocketConnect> {
	try {
		const moduleName = "cloudflare:sockets";
		const sockets = await import(
			/* webpackIgnore: true */
			/* @vite-ignore */
			moduleName
		) as { connect: CloudflareSocketConnect };
		return sockets.connect;
	} catch {
		throw new Error("IMAP import requires the Cloudflare Workers socket runtime");
	}
}

class ImapConnection {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private decoder = new TextDecoder();
	private encoder = new TextEncoder();
	// Unread bytes live in buffer[start, end). Capacity grows by doubling so large
	// literals are not recopied on every socket chunk.
	private buffer = new Uint8Array(64 * 1024);
	private start = 0;
	private end = 0;
	private scanned = 0;
	private tagCounter = 0;

	constructor(socket: Socket) {
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
	}

	async close(): Promise<void> {
		try {
			await this.writer.close();
		} catch {
			// Socket may already be closed by the server.
		}
	}

	async readGreeting(): Promise<void> {
		const line = await this.readLine();
		if (!line.startsWith("* OK")) throw new Error("IMAP server did not send an OK greeting");
	}

	async command(command: string): Promise<string[]> {
		const tag = this.nextTag();
		await this.write(`${tag} ${command}\r\n`);
		const lines: string[] = [];
		while (true) {
			const line = await this.readLine();
			lines.push(line);
			if (isTaggedCompletion(line, tag)) {
				if (!line.toUpperCase().includes(" OK")) {
					throw new Error(`IMAP command failed: ${line}`);
				}
				return lines;
			}
		}
	}

	/** Sizes in bytes by UID, so a batch can be planned against the memory budget before any body is read. */
	async fetchSizes(uids: string[]): Promise<Map<string, number>> {
		const sizes = new Map<string, number>();
		if (!uids.length) return sizes;
		for (const line of await this.command(`UID FETCH ${uids.join(",")} (RFC822.SIZE)`)) {
			const uid = line.match(/\bUID (\d+)/i)?.[1];
			const size = line.match(/\bRFC822\.SIZE (\d+)/i)?.[1];
			if (uid && size) sizes.set(uid, Number(size));
		}
		return sizes;
	}

	/**
	 * Sends every FETCH before reading any reply, so a group costs one round trip
	 * instead of one per message. Replies come back in command order.
	 */
	async fetchMessages(uids: string[]): Promise<{ uid: string; raw: ArrayBuffer; flags: string[] }[]> {
		const tags = uids.map(() => this.nextTag());
		// BODY.PEEK[] leaves the source's \Seen flag untouched, unlike RFC822.
		await this.write(uids.map((uid, index) => `${tags[index]} UID FETCH ${uid} (FLAGS BODY.PEEK[])\r\n`).join(""));
		const fetched: { uid: string; raw: ArrayBuffer; flags: string[] }[] = [];
		for (const [index, uid] of uids.entries()) {
			fetched.push({ uid, ...(await this.readFetchReply(tags[index])) });
		}
		return fetched;
	}

	private async readFetchReply(tag: string): Promise<{ raw: ArrayBuffer; flags: string[] }> {
		let raw: ArrayBuffer | null = null;
		let flags: string[] = [];

		while (true) {
			const line = await this.readLine();
			flags = parseFetchFlags(line) ?? flags;
			const literalLength = getLiteralLength(line);
			if (literalLength !== null) {
				raw = await this.readBytes(literalLength);
				continue;
			}
			if (isTaggedCompletion(line, tag)) {
				if (!line.toUpperCase().includes(" OK")) {
					throw new Error(`IMAP fetch failed: ${line}`);
				}
				if (!raw) throw new Error("IMAP fetch returned no message");
				return { raw, flags };
			}
		}
	}

	private nextTag(): string {
		this.tagCounter += 1;
		return `A${String(this.tagCounter).padStart(4, "0")}`;
	}

	private async write(value: string): Promise<void> {
		await this.writer.write(this.encoder.encode(value));
	}

	private async readLine(): Promise<string> {
		while (true) {
			const index = findCrlf(this.buffer, Math.max(this.start, this.scanned), this.end);
			if (index >= 0) {
				const line = this.decoder.decode(this.buffer.subarray(this.start, index));
				this.start = index + 2;
				this.scanned = this.start;
				return line;
			}
			this.scanned = Math.max(this.start, this.end - 1);
			await this.readMore();
		}
	}

	private async readBytes(length: number): Promise<ArrayBuffer> {
		while (this.end - this.start < length) {
			await this.readMore();
		}
		const bytes = this.buffer.slice(this.start, this.start + length);
		this.start += length;
		this.scanned = this.start;
		return bytes.buffer;
	}

	private async readMore(): Promise<void> {
		const { value, done } = await this.reader.read();
		if (done || !value) throw new Error("IMAP connection closed unexpectedly");
		this.ensureCapacity(value.byteLength);
		this.buffer.set(value, this.end);
		this.end += value.byteLength;
	}

	private ensureCapacity(extra: number): void {
		const unread = this.end - this.start;
		if (this.end + extra <= this.buffer.byteLength) return;
		let capacity = this.buffer.byteLength;
		while (unread + extra > capacity) capacity *= 2;
		if (capacity === this.buffer.byteLength) {
			this.buffer.copyWithin(0, this.start, this.end);
		} else {
			const next = new Uint8Array(capacity);
			next.set(this.buffer.subarray(this.start, this.end));
			this.buffer = next;
		}
		this.scanned = Math.max(0, this.scanned - this.start);
		this.start = 0;
		this.end = unread;
	}
}

function findCrlf(buffer: Uint8Array, from: number, to: number): number {
	for (let index = from; index < to - 1; index += 1) {
		if (buffer[index] === 13 && buffer[index + 1] === 10) return index;
	}
	return -1;
}

export type ImapFetchResult = {
	messages: ImportMessageInput[];
	/** Messages in the folder when the batch was fetched. */
	total: number;
	/** Offset for the next batch, or null when no older messages remain. */
	nextOffset: number | null;
};

export async function fetchImapMessages(input: ImapImportInput): Promise<ImapFetchResult> {
	assertSafeImapHost(input.host);
	const connect = await getCloudflareSocketConnect();
	const socket = connect(
		{ hostname: input.host, port: input.port },
		{ secureTransport: input.secure ? "on" : "off", allowHalfOpen: false },
	);
	const imap = new ImapConnection(socket);
	try {
		await imap.readGreeting();
		await imap.command(`LOGIN ${quoteImapString(input.username)} ${quoteImapString(input.password)}`);
		await imap.command(`EXAMINE ${quoteImapString(input.folder)}`);
		const searchLines = await imap.command("UID SEARCH ALL");
		const batch = selectImapUidBatch(searchLines.flatMap(parseSearchUids), input.limit, input.offset);
		const messages: ImportMessageInput[] = [];
		const newestFirst = [...batch.uids].reverse();
		const sizes = await imap.fetchSizes(newestFirst);
		for (const group of planImapFetchGroups(newestFirst, sizes)) {
			for (const { uid, raw, flags } of await imap.fetchMessages(group)) {
				messages.push({
					filename: `${input.folder}-${uid}.eml`,
					raw,
					read: flags.includes("\\SEEN"),
					starred: flags.includes("\\FLAGGED"),
				});
			}
		}
		await imap.command("LOGOUT").catch(() => undefined);
		const complete = messages.length === batch.uids.length;
		return {
			messages: messages.reverse(),
			total: batch.total,
			nextOffset: complete ? batch.nextOffset : Math.min(input.offset, batch.total) + messages.length,
		};
	} finally {
		await imap.close();
	}
}

export async function listImapFolders(input: Omit<ImapImportInput, "folder" | "limit" | "offset">): Promise<string[]> {
	assertSafeImapHost(input.host);
	const connect = await getCloudflareSocketConnect();
	const socket = connect(
		{ hostname: input.host, port: input.port },
		{ secureTransport: input.secure ? "on" : "off", allowHalfOpen: false },
	);
	const imap = new ImapConnection(socket);
	try {
		await imap.readGreeting();
		await imap.command(`LOGIN ${quoteImapString(input.username)} ${quoteImapString(input.password)}`);
		const lines = await imap.command('LIST "" "*"');
		await imap.command("LOGOUT").catch(() => undefined);
		return Array.from(new Set(lines.map(parseListMailboxName).filter((name): name is string => !!name)));
	} finally {
		await imap.close();
	}
}
