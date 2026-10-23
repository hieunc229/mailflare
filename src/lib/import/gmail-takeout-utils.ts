/**
 * Google Takeout (Gmail .mbox) import, shared by the import page and scripts/import-gmail-takeout.mjs.
 * Runtime-free on purpose: the script loads this file directly with Node's type stripping, so it may only
 * have type imports.
 */
import type {
	TakeoutBatchMessage,
	TakeoutDestination,
	TakeoutImportOptions,
	TakeoutImportSummary,
	TakeoutLabelOptions,
	TakeoutPlacement,
	TakeoutSection,
	TakeoutUploadResponse,
} from "./gmail-takeout-types";

export const TAKEOUT_MAX_BATCH_MESSAGES = 100;
export const TAKEOUT_MAX_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 60 * 1024 * 1024;
/** The import endpoint caps a whole request at 25 MiB, form overhead included. */
export const TAKEOUT_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const MAX_FOLDER_NAME = 80;
const MAX_KEPT_ERRORS = 50;
const MAX_ATTEMPTS = 4;

const SYSTEM_LABELS: Record<Exclude<TakeoutSection, "archived">, string[]> = {
	inbox: ["inbox", "posteingang"],
	sent: ["sent", "gesendet"],
	drafts: ["drafts", "draft", "entwürfe"],
	spam: ["spam"],
	trash: ["trash", "bin", "papierkorb"],
};
const SECTION_PRIORITY = ["trash", "spam", "drafts", "sent", "inbox"] as const;
const STARRED_LABELS = ["starred", "markiert"];
const UNREAD_LABELS = ["unread", "ungelesen"];
const IGNORED_LABELS = ["opened", "geöffnet", "important", "wichtig", "archived", "archiviert", "chat", "chats"];
const IGNORED_LABEL_PREFIXES = ["category ", "kategorie "];
const KNOWN_LABELS = new Set([...Object.values(SYSTEM_LABELS).flat(), ...STARRED_LABELS, ...UNREAD_LABELS]);

const LF = 10;
const CR = 13;
const FROM_ = [70, 114, 111, 109, 32];

function startsWithFrom(line: Uint8Array, offset = 0): boolean {
	if (line.length < offset + FROM_.length) return false;
	return FROM_.every((byte, index) => line[offset + index] === byte);
}

function isBlankLine(line: Uint8Array): boolean {
	return line.length === 0 || (line.length === 1 && line[0] === LF) || (line.length === 2 && line[0] === CR && line[1] === LF);
}

function escapedFromDepth(line: Uint8Array): number {
	let depth = 0;
	while (depth < line.length && line[depth] === 62) depth += 1;
	return depth > 0 && startsWithFrom(line, depth) ? depth : 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

/**
 * Splits an mbox byte stream into raw RFC 822 messages without decoding them, so 8-bit and binary content
 * survives unchanged. A "From " line only starts a message after a blank line; mboxrd ">From " escapes are undone.
 */
export async function* splitMbox(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
	let carry: Uint8Array = new Uint8Array(0);
	let parts: Uint8Array[] | null = null;
	let previousBlank = true;

	function finish(): Uint8Array | null {
		if (!parts) return null;
		while (parts.length > 0 && isBlankLine(parts[parts.length - 1])) parts.pop();
		const raw = concatBytes(parts);
		parts = null;
		return raw;
	}

	function handle(line: Uint8Array): Uint8Array | null {
		const separator = previousBlank && startsWithFrom(line);
		previousBlank = isBlankLine(line);
		if (separator) {
			const raw = finish();
			parts = [];
			return raw;
		}
		if (parts) parts.push(line.subarray(escapedFromDepth(line) > 0 ? 1 : 0));
		return null;
	}

	for await (const chunk of chunks) {
		const data = carry.length > 0 ? concatBytes([carry, chunk]) : chunk;
		let start = 0;
		while (true) {
			const end = data.indexOf(LF, start);
			if (end === -1) break;
			const raw = handle(data.subarray(start, end + 1));
			if (raw) yield raw;
			start = end + 1;
		}
		carry = data.slice(start);
	}
	if (carry.length > 0) {
		const raw = handle(carry);
		if (raw) yield raw;
	}
	const last = finish();
	if (last) yield last;
}

function headerEnd(raw: Uint8Array): number {
	const limit = Math.min(raw.length, 64 * 1024);
	let index = raw.indexOf(LF);
	while (index !== -1 && index < limit) {
		if (raw[index + 1] === LF) return index;
		if (raw[index + 1] === CR && raw[index + 2] === LF) return index;
		index = raw.indexOf(LF, index + 1);
	}
	return limit;
}

function decodeEncodedWords(value: string): string {
	return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (match, charset: string, encoding: string, text: string) => {
		try {
			const binary = encoding.toLowerCase() === "b"
				? atob(text)
				: text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
			return new TextDecoder(charset).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
		} catch {
			return match;
		}
	});
}

/** Reads the X-Gmail-Labels header of a raw message. */
export function parseGmailLabels(raw: Uint8Array): string[] {
	const headers = new TextDecoder().decode(raw.subarray(0, headerEnd(raw))).replace(/\r?\n[ \t]+/g, " ");
	const match = headers.match(/^X-Gmail-Labels:[ \t]*(.*)$/im);
	if (!match) return [];
	const labels: string[] = [];
	let current = "";
	let quoted = false;
	for (const char of decodeEncodedWords(match[1])) {
		if (char === '"') quoted = !quoted;
		else if (char === "," && !quoted) {
			labels.push(current.trim());
			current = "";
		} else current += char;
	}
	labels.push(current.trim());
	return labels.filter(Boolean);
}

function isIgnoredLabel(label: string, ignore: string[]): boolean {
	const name = label.toLowerCase();
	if (IGNORED_LABELS.includes(name) || IGNORED_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
	return ignore.some((entry) => {
		const value = entry.trim().toLowerCase();
		if (!value) return false;
		return value.endsWith("/") ? name === value.slice(0, -1) || name.startsWith(value) : name === value;
	});
}

/** Decides where a message goes from its Gmail labels. */
export function mapGmailLabels(labels: string[], options: TakeoutLabelOptions = {}): TakeoutPlacement {
	const names = labels.map((label) => label.toLowerCase());
	const read = !names.some((name) => UNREAD_LABELS.includes(name));
	const starred = names.some((name) => STARRED_LABELS.includes(name));
	const section = SECTION_PRIORITY.find((key) => names.some((name) => SYSTEM_LABELS[key].includes(name)));
	if (section) return { destination: { type: "system", section }, read, starred };

	const folder = options.folders === false
		? undefined
		: labels.find((label) => !KNOWN_LABELS.has(label.toLowerCase()) && !isIgnoredLabel(label, options.ignore ?? []));
	if (folder) return { destination: { type: "folder", name: folder.slice(0, MAX_FOLDER_NAME) }, read, starred };
	return { destination: { type: "system", section: "archived" }, read, starred };
}

export function takeoutDestinationKey(destination: TakeoutDestination): string {
	return destination.type === "folder" ? `folder:${destination.name}` : `system:${destination.section}`;
}

/** Splits a comma-separated list of labels to ignore. */
export function parseIgnoredLabels(value: string): string[] {
	return value.split(",").map((label) => label.trim()).filter(Boolean);
}

function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(signal?.reason);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface PendingGroup {
	destination: TakeoutDestination;
	messages: TakeoutBatchMessage[];
	bytes: number;
	first: number;
}

/**
 * Reads messages from an mbox stream and uploads them in batches per destination. Batches that are too large
 * or keep failing on the server are split; a single message that still fails is counted and skipped. Only
 * errors that are not about the batch (sign-in, missing mailbox) stop the run.
 */
export async function runTakeoutImport(messages: AsyncIterable<Uint8Array>, options: TakeoutImportOptions): Promise<TakeoutImportSummary> {
	const { signal, upload, resolveFolder } = options;
	if (!options.dryRun && (!upload || !resolveFolder)) throw new Error("upload and resolveFolder are required");
	const wait = options.wait ?? abortableWait;
	const startAt = Math.max(0, options.startAt ?? 0);
	const summary: TakeoutImportSummary = {
		read: 0,
		imported: 0,
		skipped: 0,
		failed: 0,
		errors: [],
		tooLarge: 0,
		ignored: 0,
		committed: startAt,
		destinations: {},
		aborted: false,
	};
	const groups = new Map<string, PendingGroup>();
	const folderIds = new Map<string, string>();
	let buffered = 0;
	/** Consecutive single messages the server kept failing on; a few in a row means the server, not the mail. */
	let singleFailures = 0;

	function addErrors(errors: string[]) {
		summary.failed += errors.length;
		summary.errors.push(...errors.slice(0, Math.max(0, MAX_KEPT_ERRORS - summary.errors.length)));
	}

	function updateCommitted() {
		let lowest = summary.read + 1;
		for (const group of groups.values()) lowest = Math.min(lowest, group.first);
		summary.committed = Math.max(summary.committed, lowest - 1);
	}

	async function destinationValue(destination: TakeoutDestination): Promise<string> {
		if (destination.type === "system") return `system:${destination.section}`;
		let id = folderIds.get(destination.name.toLowerCase());
		if (!id) {
			id = await resolveFolder!(destination.name);
			folderIds.set(destination.name.toLowerCase(), id);
		}
		return `folder:${id}`;
	}

	async function send(destination: string, batch: TakeoutBatchMessage[]): Promise<void> {
		for (let attempt = 1; ; attempt += 1) {
			signal?.throwIfAborted();
			let status = 0;
			let data: TakeoutUploadResponse["data"] = {};
			try {
				({ status, data } = await upload!(destination, batch, signal));
			} catch (error) {
				signal?.throwIfAborted();
				data = { error: error instanceof Error ? error.message : String(error) };
			}
			if (status >= 200 && status < 300) {
				singleFailures = 0;
				summary.imported += data.imported ?? 0;
				summary.skipped += data.skipped ?? 0;
				addErrors(data.errors ?? []);
				return;
			}
			if (batch.length > 1 && (status === 413 || (status >= 500 && attempt >= 2))) {
				const middle = Math.ceil(batch.length / 2);
				await send(destination, batch.slice(0, middle));
				await send(destination, batch.slice(middle));
				return;
			}
			const reason = typeof data.error === "string" ? data.error : JSON.stringify(data.error ?? data);
			const retryable = status === 0 || status === 429 || status >= 500;
			if (batch.length === 1 && (status === 413 || (retryable && attempt >= MAX_ATTEMPTS))) {
				singleFailures += 1;
				if (status !== 413 && singleFailures >= 3) throw new Error(`Upload failed (${status || "network error"}): ${reason}`);
				addErrors([`${batch[0].filename}: ${status === 413 ? "too large for one upload" : reason}`]);
				return;
			}
			if (!retryable || attempt >= MAX_ATTEMPTS) throw new Error(`Upload failed (${status || "network error"}): ${reason}`);
			await wait(5000 * 3 ** (attempt - 1), signal);
		}
	}

	async function flush(key: string): Promise<void> {
		const group = groups.get(key);
		if (!group) return;
		await send(await destinationValue(group.destination), group.messages);
		groups.delete(key);
		buffered -= group.bytes;
		updateCommitted();
		options.onProgress?.(summary);
	}

	try {
		for await (const raw of messages) {
			signal?.throwIfAborted();
			summary.read += 1;
			const index = summary.read;
			if (index <= startAt) continue;
			const { destination, read, starred } = mapGmailLabels(parseGmailLabels(raw), options.labels);
			const section = destination.type === "system" ? destination.section : null;
			if ((options.skipSpam && section === "spam") || (options.skipTrash && section === "trash")) {
				summary.ignored += 1;
			} else if (raw.length > TAKEOUT_MAX_MESSAGE_BYTES) {
				summary.tooLarge += 1;
			} else {
				const key = takeoutDestinationKey(destination);
				summary.destinations[key] = (summary.destinations[key] ?? 0) + 1;
				if (!options.dryRun) {
					const existing = groups.get(key);
					if (existing && (existing.messages.length >= TAKEOUT_MAX_BATCH_MESSAGES || existing.bytes + raw.length > TAKEOUT_MAX_BATCH_BYTES)) {
						await flush(key);
					}
					const group = groups.get(key) ?? { destination, messages: [], bytes: 0, first: index };
					group.messages.push({ filename: `takeout-${index}.eml`, raw, read, starred });
					group.bytes += raw.length;
					groups.set(key, group);
					buffered += raw.length;
					while (buffered > MAX_BUFFERED_BYTES) {
						const [largest] = [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
						await flush(largest[0]);
					}
				}
			}
			if (groups.size === 0) summary.committed = Math.max(summary.committed, index);
			if (index % 200 === 0) options.onProgress?.(summary);
		}
		for (const key of [...groups.keys()]) await flush(key);
		summary.committed = Math.max(summary.committed, summary.read);
	} catch (error) {
		if (!signal?.aborted) throw error;
		summary.aborted = true;
	}
	options.onProgress?.(summary);
	return summary;
}
