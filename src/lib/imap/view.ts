import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { imapMessageFlags, messages } from "@/db/schema";
import { folderKeyOf } from "./folders";
import { ensureFolderState, syncMailbox } from "./sync";

/**
 * The selected folder as the client sees it: the folder's UIDs in order (the index
 * plus one is the message sequence number) as of the last time the client was told.
 * `refresh` brings it up to date with the IMAP state tables and says what to send;
 * between refreshes nothing changes, so sequence numbers stay stable while a FETCH,
 * STORE or SEARCH runs (RFC 3501 section 7.4.1).
 */
export type ViewUpdate = {
	/** Sequence numbers of removed messages, highest first, each valid when it is sent. */
	expunged: number[];
	/** The message count to announce, when it is not the count the client already has after the expunges. */
	exists: number | null;
	/** Messages whose flags changed, by their number after the expunges. */
	flagged: Array<{ msn: number; uid: number }>;
	/** The folder was reset: UIDs are no longer comparable and the session must end. */
	uidvalidityChanged: boolean;
};

type FolderStateRow = { uidvalidity: number; uid_next: number; highest_modseq: number };

const ID_CHUNK = 90;

export class FolderView {
	uids: number[] = [];
	messageIds: string[] = [];
	private modseqs: number[] = [];
	uidvalidity = 0;
	uidNext = 1;
	private highestModseq = -1;

	private constructor(private readonly env: CloudflareEnv, readonly mailboxId: string, readonly folderKey: string) {}

	static async open(env: CloudflareEnv, mailboxId: string, folderKey: string): Promise<FolderView> {
		await syncMailbox(env, mailboxId);
		await ensureFolderState(env, mailboxId, folderKey);
		const view = new FolderView(env, mailboxId, folderKey);
		await view.load();
		return view;
	}

	get exists(): number {
		return this.uids.length;
	}

	/** The folder's highest mod-sequence as of the last time the view was read. */
	get highest(): number {
		return Math.max(this.highestModseq, 0);
	}

	private async readState(): Promise<FolderStateRow> {
		const [row] = (await this.env.DB.prepare("SELECT uidvalidity, uid_next, highest_modseq FROM imap_folder_state WHERE id = ?").bind(`${this.mailboxId}:${this.folderKey}`).all<FolderStateRow>()).results;
		if (!row) throw new Error(`No IMAP state for folder ${this.mailboxId}:${this.folderKey}`);
		return row;
	}

	/** The state is read before the UID list: a change committed in between is picked up by the next refresh. */
	private async load(): Promise<void> {
		const state = await this.readState();
		const rows = (await this.env.DB.prepare("SELECT uid, message_id, modseq FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? ORDER BY uid").bind(this.mailboxId, this.folderKey).all<{ uid: number; message_id: string; modseq: number }>()).results;
		this.uidvalidity = Number(state.uidvalidity);
		this.uidNext = Number(state.uid_next);
		this.highestModseq = Number(state.highest_modseq);
		this.uids = rows.map((row) => Number(row.uid));
		this.messageIds = rows.map((row) => row.message_id);
		this.modseqs = rows.map((row) => Number(row.modseq));
	}

	/**
	 * The client changed these messages itself and has been told: their current mod-sequences become
	 * the ones it knows, so the next refresh does not announce its own change again. Anything that
	 * another writer changed afterwards still differs and is announced.
	 */
	async noteOwn(uids: number[]): Promise<void> {
		const wanted = new Set(uids);
		const known = this.uids.filter((uid) => wanted.has(uid));
		for (let at = 0; at < known.length; at += ID_CHUNK) {
			const part = known.slice(at, at + ID_CHUNK);
			const rows = (await this.env.DB.prepare(`SELECT uid, modseq FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND uid IN (${part.map(() => "?").join(", ")})`).bind(this.mailboxId, this.folderKey, ...part).all<{ uid: number; modseq: number }>()).results;
			const byUid = new Map(rows.map((row) => [Number(row.uid), Number(row.modseq)]));
			this.uids.forEach((uid, index) => {
				const value = byUid.get(uid);
				if (value !== undefined) this.modseqs[index] = value;
			});
		}
	}

	async refresh(): Promise<ViewUpdate> {
		await syncMailbox(this.env, this.mailboxId);
		const state = await this.readState();
		const none: ViewUpdate = { expunged: [], exists: null, flagged: [], uidvalidityChanged: false };
		if (Number(state.uidvalidity) !== this.uidvalidity) return { ...none, uidvalidityChanged: true };
		if (Number(state.highest_modseq) === this.highestModseq && Number(state.uid_next) === this.uidNext) return none;
		const before = { uids: this.uids, modseqs: this.modseqs };
		await this.load();
		const kept = new Map(this.uids.map((uid, index) => [uid, index]));
		const expunged: number[] = [];
		for (let index = before.uids.length - 1; index >= 0; index -= 1) if (!kept.has(before.uids[index])) expunged.push(index + 1);
		const after = before.uids.length - expunged.length;
		const flagged: ViewUpdate["flagged"] = [];
		const previous = new Map(before.uids.map((uid, index) => [uid, before.modseqs[index]]));
		this.uids.forEach((uid, index) => {
			const old = previous.get(uid);
			if (old !== undefined && old !== this.modseqs[index]) flagged.push({ msn: index + 1, uid });
		});
		return { expunged, exists: this.uids.length !== after ? this.uids.length : null, flagged, uidvalidityChanged: false };
	}
}

export type MessageFlagsRow = {
	id: string;
	read: boolean;
	starred: boolean;
	status: string;
	createdAt: Date;
	answered: boolean | null;
	forwarded: boolean | null;
	deleted: boolean | null;
	keywords: string | null;
};

/** The columns FETCH and SEARCH need per message, for messages of this mailbox only (and, with `folderKey`, only those still in that folder). */
export async function loadMessageRows(env: CloudflareEnv, mailboxId: string, ids: string[], folderKey?: string): Promise<Map<string, MessageFlagsRow>> {
	const result = new Map<string, MessageFlagsRow>();
	const db = getDb(env);
	for (let at = 0; at < ids.length; at += ID_CHUNK) {
		const rows = await db
			.select({ id: messages.id, folderId: messages.folderId, read: messages.read, starred: messages.starred, status: messages.status, createdAt: messages.createdAt, answered: imapMessageFlags.answered, forwarded: imapMessageFlags.forwarded, deleted: imapMessageFlags.deleted, keywords: imapMessageFlags.keywords })
			.from(messages)
			.leftJoin(imapMessageFlags, eq(imapMessageFlags.messageId, messages.id))
			.where(and(eq(messages.mailboxId, mailboxId), inArray(messages.id, ids.slice(at, at + ID_CHUNK))));
		for (const { folderId, ...row } of rows) {
			if (folderKey === undefined || folderKeyOf({ mailboxId, folderId, status: row.status }) === folderKey) result.set(row.id, row);
		}
	}
	return result;
}

/** What a keyword may look like on the wire: an atom, so it can never carry a line break or a delimiter. */
const KEYWORD_CHARS = "!#$&'+,.0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~-";
const isKeyword = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64 && [...value].every((char) => KEYWORD_CHARS.includes(char));

export function flagsOf(row: MessageFlagsRow): string[] {
	const flags: string[] = [];
	if (row.read) flags.push("\\Seen");
	if (row.starred) flags.push("\\Flagged");
	if (row.status === "draft") flags.push("\\Draft");
	if (row.answered) flags.push("\\Answered");
	if (row.deleted) flags.push("\\Deleted");
	if (row.forwarded) flags.push("$Forwarded");
	if (row.keywords) {
		try {
			const parsed: unknown = JSON.parse(row.keywords);
			if (Array.isArray(parsed)) for (const keyword of parsed.slice(0, 50)) if (isKeyword(keyword) && !flags.includes(keyword)) flags.push(keyword);
		} catch {
			// A damaged keyword list shows no keywords rather than failing the fetch.
		}
	}
	return flags;
}
