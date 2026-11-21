import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { imapMessageCache, messageAttachments, messages } from "@/db/schema";
import bodystructure from "../../../server/imap/vendor/imapkit/bodystructure.js";
import envelope from "../../../server/imap/vendor/imapkit/envelope.js";
import { embeddedMessage, headerSection, normalizeLineBreaks, parseTree, partsOf, type MimeNode } from "../../../server/imap/vendor/imapkit/mimeparser.js";
import { synthesizeMessage, type SynthAttachment } from "./synthesize";

/**
 * What FETCH needs of a message, computed once and kept in `imap_message_cache`:
 * the ENVELOPE, the BODYSTRUCTURE, the size of the bytes served and, for every
 * numbered part, where its header and body sit in those bytes. Section fetches
 * then read only a byte range of the object, never the whole message.
 *
 * The bytes served are always CRLF-normalised, so offsets are plain object
 * offsets: a stored raw message that is already CRLF is served as it is; one with
 * bare line breaks, and every message without raw bytes (a draft never uses them,
 * the composer edits the columns), is written once to
 * `imap-cache/<messageId>/<content hash>.eml` (the cache row's `synth_key`) and
 * served from there. The key holds the hash of the bytes, so an object is never
 * overwritten with different bytes.
 *
 * A message the indexer cannot describe gets a cache row with a negative size,
 * the reason and a hash of the columns it was built from, so it is not parsed again
 * on every FETCH until one of those columns changes.
 */
type Env = Pick<CloudflareEnv, "DB" | "BUCKET"> & { MAIL_HOSTNAME?: string };

export const CACHE_PREFIX = "imap-cache/";
export const cacheKey = (messageId: string, hash: string) => `${CACHE_PREFIX}${messageId}/${hash}.eml`;

/** `[header start, body start, body end]`, plus the same three for the message inside a message/rfc822 part. */
type Span = [number, number, number];
type PartRanges = { span: Span; inner?: Span };
type Ranges = Record<string, PartRanges>;

export type MimeIndex = { size: number; headerSize: number; envelope: unknown[]; bodystructure: unknown[]; ranges: Ranges };

export class MimeIndexError extends Error {}

/** Nothing deeper is walked by the recursive helpers; the parser stops splitting far above this. */
const MAX_TREE_DEPTH = 200;
/** Bump when the indexer or the parser changes in a way that could let a refused message through. */
export const INDEXER_VERSION = 1;
/** Cache rows with this size mark a message that cannot be indexed. */
const UNINDEXABLE = -1;

/** One view of the octets, never a copy. */
const binary = (bytes: ArrayBuffer | Uint8Array) => (bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.from(bytes)).toString("latin1");

async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : (data as BufferSource));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The depth of the tree, counted without recursion. */
function depthOf(root: MimeNode): number {
	let deepest = 0;
	const stack: Array<[MimeNode, number]> = [[root, 1]];
	while (stack.length) {
		const [node, depth] = stack.pop()!;
		deepest = Math.max(deepest, depth);
		if (deepest > MAX_TREE_DEPTH) break;
		for (const child of node.childNodes ?? []) stack.push([child, depth + 1]);
		const inner = embeddedMessage(node);
		if (inner) stack.push([inner, depth + 1]);
	}
	return deepest;
}

/** The octets of every entity, found by walking the tree the way the parser's `render` writes it. */
function spanOf(node: MimeNode, start: number, spans: Map<MimeNode, Span>): number {
	const bodyStart = start + headerSection(node).length;
	let end = bodyStart;
	if (node.hasBody !== false) {
		end += (node.body || "").length;
		if (node.boundary) {
			const children = node.childNodes || [];
			children.forEach((child, index) => {
				end += `--${node.boundary}${child.pad || ""}\r\n`.length;
				end = spanOf(child, end, spans);
				if ((!node.unterminated || index < children.length - 1) && !child.bare) end += 2;
			});
			if (!node.unterminated) end += `--${node.boundary}--${node.closePad || ""}`.length + (node.epilogue || "").length;
		}
	}
	spans.set(node, [start, bodyStart, end]);
	// A message/rfc822 part's body is the inner message, parsed separately, so its offsets start at the part's body.
	const inner = embeddedMessage(node);
	if (inner && spanOf(inner, bodyStart, spans) !== end) throw new MimeIndexError("Embedded message does not fill its part");
	return end;
}

/** Part numbers as IMAP gives them (RFC 3501 6.4.5), mapped to the octets of that part. */
function numberParts(scope: MimeNode, prefix: string, spans: Map<MimeNode, Span>, ranges: Ranges, scopeEnd: number): void {
	const add = (path: string, node: MimeNode | undefined) => {
		const span = node ? spans.get(node) ?? ([scopeEnd, scopeEnd, scopeEnd] as Span) : ([scopeEnd, scopeEnd, scopeEnd] as Span);
		const inner = node ? embeddedMessage(node) : undefined;
		ranges[path] = { span, ...(inner ? { inner: spans.get(inner) } : {}) };
		return node;
	};
	const descend = (node: MimeNode | undefined, path: string) => {
		const inner = node ? embeddedMessage(node) : undefined;
		const next = inner ?? (node && partsOf(node) ? node : undefined);
		if (next) numberParts(next, `${path}.`, spans, ranges, spans.get(next)?.[2] ?? scopeEnd);
	};
	const parts = partsOf(scope);
	if (!parts) {
		add(`${prefix}1`, scope);
		descend(scope, `${prefix}1`);
		return;
	}
	parts.forEach((child, index) => {
		const path = `${prefix}${index + 1}`;
		add(path, spans.has(child) ? child : undefined);
		descend(spans.has(child) ? child : undefined, path);
	});
}

/** Parses CRLF-normalised message octets (a binary string) into everything the cache keeps. */
export function indexMime(source: string): MimeIndex {
	try {
		const tree = parseTree(source);
		if (depthOf(tree) > MAX_TREE_DEPTH) throw new MimeIndexError("The message is nested too deeply");
		const spans = new Map<MimeNode, Span>();
		const end = spanOf(tree, 0, spans);
		if (end !== source.length) throw new MimeIndexError("The parsed tree does not reproduce the message");
		const ranges: Ranges = { "": { span: spans.get(tree)! } };
		numberParts(tree, "", spans, ranges, end);
		return { size: source.length, headerSize: spans.get(tree)![1], envelope: envelope(tree.parsedHeader), bodystructure: bodystructure(tree), ranges };
	} catch (error) {
		throw asIndexError(error);
	}
}

/** Whatever the indexer trips over, the caller sees one error type. */
function asIndexError(error: unknown): MimeIndexError {
	if (error instanceof MimeIndexError) return error;
	return new MimeIndexError(error instanceof Error ? `${error.name}: ${error.message}` : "The message cannot be indexed", { cause: error });
}

/**
 * The compiler of FETCH responses writes the bodies of a multipart and the
 * addresses of an envelope without spaces between them, which the builders mark
 * with a property JSON drops. A list that starts with a list is such a list.
 */
export function reviveLists<T>(value: T): T {
	if (Array.isArray(value)) {
		value.forEach(reviveLists);
		if (Array.isArray(value[0])) Object.defineProperty(value, "adjacentLists", { value: true });
	}
	return value;
}

export type CachedMessage = MimeIndex & { key: string };

type CacheJson = { s: unknown[]; r: Ranges };

// ---- Building the cache row ----

type MessageRow = typeof messages.$inferSelect;

async function loadAttachments(env: Env, messageId: string): Promise<SynthAttachment[]> {
	const rows = await getDb(env).select().from(messageAttachments).where(and(eq(messageAttachments.messageId, messageId), isNull(messageAttachments.trashedAt))).orderBy(asc(messageAttachments.createdAt), asc(messageAttachments.id));
	const result: SynthAttachment[] = [];
	for (const row of rows) {
		const object = await env.BUCKET.get(row.r2Key);
		// A missing object stays in the message as an empty part, so the part count and names do not shift.
		result.push({ filename: row.filename, contentType: row.contentType, disposition: row.disposition, contentId: row.contentId, bytes: object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array() });
	}
	return result;
}

/**
 * The columns the served bytes depend on, to notice an edit that raced the build
 * and a change that makes a recorded failure stale.
 */
const contentKey = (row: MessageRow) => JSON.stringify([row.fromAddr, row.toAddr, row.ccAddr, row.bccAddr, row.replyTo, row.subject, row.textBody, row.htmlBody, row.providerMessageId, row.inReplyTo, row.references, row.rawR2Key, usesRaw(row)]);

/**
 * Whether the stored raw bytes are what the message is. A draft is edited through
 * its columns (the web composer, the agent, JMAP) and none of those touch the
 * object, so for a draft the columns win and the bytes are synthesized from them.
 */
const usesRaw = (row: MessageRow) => Boolean(row.rawR2Key) && row.status !== "draft";

/** Sent rows whose bytes still change: the provider's Message-ID arrives when the send completes. */
const settling = (row: MessageRow) => row.direction === "outbound" && (row.status === "queued" || row.status === "scheduled" || row.status === "sending");

function hostnameFor(env: Env, row: MessageRow): string {
	return env.MAIL_HOSTNAME || row.fromAddr.split("@").pop()?.replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
}

type Built = { text: string; /** the octets, when they are not the stored object */ bytes: Uint8Array | null; rawMissing: boolean };

async function build(env: Env, row: MessageRow): Promise<Built> {
	let rawMissing = false;
	if (usesRaw(row)) {
		const object = await env.BUCKET.get(row.rawR2Key!);
		if (object) {
			const stored = binary(await object.arrayBuffer());
			const normalized = normalizeLineBreaks(stored);
			return normalized === stored ? { text: stored, bytes: null, rawMissing } : { text: normalized, bytes: Buffer.from(normalized, "latin1"), rawMissing };
		}
		rawMissing = row.direction === "inbound";
	}
	const bytes = synthesizeMessage(row, await loadAttachments(env, row.id), { hostname: hostnameFor(env, row) });
	return { text: binary(bytes), bytes, rawMissing };
}

async function readRow(env: Env, messageId: string) {
	const [row] = await getDb(env)
		.select({ cache: imapMessageCache, rawR2Key: messages.rawR2Key })
		.from(imapMessageCache)
		.innerJoin(messages, eq(messages.id, imapMessageCache.messageId))
		.where(eq(imapMessageCache.messageId, messageId))
		.limit(1);
	return row;
}

function fromCache(row: NonNullable<Awaited<ReturnType<typeof readRow>>>): CachedMessage {
	const structure = JSON.parse(row.cache.bodystructure) as CacheJson;
	return {
		size: Number(row.cache.size),
		headerSize: Number(row.cache.headerSize),
		envelope: reviveLists(JSON.parse(row.cache.envelope)),
		bodystructure: reviveLists(structure.s),
		ranges: structure.r,
		key: row.cache.synthKey ?? row.rawR2Key ?? "",
	};
}

/** What a recorded refusal is tied to: the indexer, the columns, and the attachments a synthesized message carries. */
export async function refusalKey(env: Env, row: MessageRow, version = INDEXER_VERSION): Promise<string> {
	const attached = usesRaw(row) ? [] : (await getDb(env).select({ id: messageAttachments.id }).from(messageAttachments).where(and(eq(messageAttachments.messageId, row.id), isNull(messageAttachments.trashedAt))).orderBy(asc(messageAttachments.id))).map((attachment) => attachment.id);
	return sha256Hex(JSON.stringify([version, contentKey(row), attached]));
}

/** The row of a message the indexer cannot describe: the reason, and the key of what it was built from. */
async function recordUnindexable(env: Env, row: MessageRow, error: MimeIndexError): Promise<void> {
	await getDb(env)
		.insert(imapMessageCache)
		.values({ messageId: row.id, size: UNINDEXABLE, synthKey: null, envelope: JSON.stringify({ unindexable: error.message.slice(0, 200) }), bodystructure: JSON.stringify({ k: await refusalKey(env, row) }), headerSize: 0 })
		.onConflictDoNothing();
}

/**
 * The cached description of a message, built on first use. Null when the message
 * does not exist. Throws MimeIndexError when the bytes cannot be described; that
 * outcome is remembered, so the message is not parsed again until it changes.
 * `index` is the indexer, a parameter so that a test can make it refuse a message.
 */
export async function getMessageIndex(env: Env, messageId: string, index: (source: string) => MimeIndex = indexMime): Promise<CachedMessage | null> {
	const cached = await readRow(env, messageId);
	const db = getDb(env);
	if (cached && Number(cached.cache.size) !== UNINDEXABLE) return fromCache(cached);
	if (cached) {
		const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
		if (!row) return null;
		const recorded = JSON.parse(cached.cache.bodystructure) as { k?: string };
		if (recorded.k === (await refusalKey(env, row))) throw new MimeIndexError((JSON.parse(cached.cache.envelope) as { unindexable?: string }).unindexable ?? "The message cannot be indexed");
		await db.delete(imapMessageCache).where(eq(imapMessageCache.messageId, messageId));
	}
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
		if (!row) return null;
		const built = await build(env, row);
		// A row that is still being sent changes bytes when the send completes, so nothing about it is kept.
		const keep = !settling(row);
		let described: MimeIndex;
		try {
			described = index(built.text);
		} catch (error) {
			const failure = asIndexError(error);
			if (keep) await recordUnindexable(env, row, failure);
			throw failure;
		}
		const synthKey = built.bytes ? cacheKey(row.id, (await sha256Hex(built.bytes)).slice(0, 32)) : null;
		if (synthKey) await env.BUCKET.put(synthKey, built.bytes!, { httpMetadata: { contentType: "message/rfc822" } });
		const key = synthKey ?? row.rawR2Key ?? "";
		if (!keep) return { ...described, key };
		await db.insert(imapMessageCache).values({ messageId, size: described.size, synthKey, envelope: JSON.stringify(described.envelope), bodystructure: JSON.stringify({ s: described.bodystructure, r: described.ranges } satisfies CacheJson), headerSize: described.headerSize }).onConflictDoNothing();
		// A draft edited while this ran would stay cached with the old bytes; the sync that sees the edit may have run before the insert.
		const [again] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
		if (again && contentKey(again) === contentKey(row)) {
			if (built.rawMissing) console.warn(`IMAP: the raw object ${row.rawR2Key} of message ${row.id} is missing; its bytes are synthesized from the stored columns`);
			return { ...described, key };
		}
		await db.delete(imapMessageCache).where(eq(imapMessageCache.messageId, messageId));
	}
	throw new MimeIndexError("The message kept changing while it was indexed");
}

// ---- Sections ----

export type SectionSpec = {
	/** "" for the whole message, else a part number such as "1.2". */
	part: string;
	kind: "all" | "header" | "text" | "mime" | "header.fields" | "header.fields.not";
	/** Field names for the two `header.fields` kinds. */
	fields?: string[];
	/** The `<offset.length>` of a partial fetch, applied to the section. */
	partial?: { offset: number; length: number };
};

export type SectionResult = { data: Uint8Array; /** octets in the whole section, before any partial */ total: number };

class MissingBytesError extends Error {}

async function readRange(env: Env, key: string, start: number, end: number): Promise<Uint8Array> {
	if (end <= start) return new Uint8Array();
	const object = await env.BUCKET.get(key, { range: { offset: start, length: end - start } });
	if (!object) throw new MissingBytesError(`IMAP message bytes are missing: ${key}`);
	return new Uint8Array(await object.arrayBuffer());
}

/** The header fields whose names are (or with `exclude`, are not) in the list, folded lines kept whole, plus the blank line. */
function filterFields(header: string, names: string[], exclude: boolean): string {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	const fields: string[] = [];
	for (const line of header.split("\r\n")) {
		if (line === "") break;
		if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1] += `\r\n${line}`;
		else fields.push(line);
	}
	const kept = fields.filter((field) => wanted.has(field.slice(0, Math.max(field.indexOf(":"), 0)).trim().toLowerCase()) !== exclude);
	return `${kept.map((field) => `${field}\r\n`).join("")}\r\n`;
}

/**
 * One FETCH body section. Null when the message or the section does not exist
 * (HEADER, TEXT and the field lists exist for the message and for message/rfc822
 * parts; MIME only for numbered parts). Reads a byte range of the stored object.
 * When that object is gone (a sweep can delete an object just before an identical
 * rebuild records it again), the cache row is dropped and the message indexed once more.
 */
export async function readSection(env: Env, messageId: string, spec: SectionSpec): Promise<SectionResult | null> {
	try {
		return await readCachedSection(env, messageId, spec);
	} catch (error) {
		if (!(error instanceof MissingBytesError)) throw error;
		await getDb(env).delete(imapMessageCache).where(eq(imapMessageCache.messageId, messageId));
		return readCachedSection(env, messageId, spec);
	}
}

async function readCachedSection(env: Env, messageId: string, spec: SectionSpec): Promise<SectionResult | null> {
	const index = await getMessageIndex(env, messageId);
	if (!index) return null;
	const entry = index.ranges[spec.part];
	if (!entry) return null;
	const [headerStart, bodyStart, bodyEnd] = entry.span;
	let range: [number, number] | null;
	if (spec.part === "") {
		range = spec.kind === "all" ? [0, index.size] : spec.kind === "text" ? [bodyStart, bodyEnd] : spec.kind === "mime" ? null : [headerStart, bodyStart];
	} else if (spec.kind === "all") range = [bodyStart, bodyEnd];
	else if (spec.kind === "mime") range = [headerStart, bodyStart];
	else range = entry.inner ? (spec.kind === "text" ? [entry.inner[1], entry.inner[2]] : [entry.inner[0], entry.inner[1]]) : null;
	if (!range) return null;
	let bytes: Uint8Array | null = null;
	let total = range[1] - range[0];
	if (spec.kind === "header.fields" || spec.kind === "header.fields.not") {
		const header = binary(await readRange(env, index.key, range[0], range[1]));
		const filtered = Buffer.from(filterFields(header, spec.fields ?? [], spec.kind === "header.fields.not"), "latin1");
		bytes = filtered;
		total = filtered.length;
	}
	const offset = Math.min(spec.partial?.offset ?? 0, total);
	const length = Math.min(spec.partial?.length ?? total, total - offset);
	if (bytes) return { data: bytes.subarray(offset, offset + length), total };
	return { data: await readRange(env, index.key, range[0] + offset, range[0] + offset + length), total };
}
