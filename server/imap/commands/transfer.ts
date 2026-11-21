import type { ParsedCommand } from "imap-handler";
import { bad, no } from "@/lib/imap/errors";
import { decodeFolderName } from "@/lib/imap/folders";
import { addRefusal, findFolder, mayAddTo } from "@/lib/imap/namespace";
import { compactSet, parseSequenceSet, resolveRanges, selectByNumber, selectByUid } from "@/lib/imap/sets";
import { MAX_COPY_MESSAGES, MAX_MOVE_MESSAGES, copyMessages, deleteUnchanged, expungeDeleted, loadFolderRows, moveMessages, uidsOf, type Destination, type MessageRow } from "@/lib/imap/transfer";
import type { Completion, ImapConnection } from "../connection";
import { args, text, type Arg } from "./args";

/** The folder a COPY or MOVE names: it must be a real folder this login may add messages to (by the folder's kind, as for APPEND). */
async function destination(c: ImapConnection, arg: Arg): Promise<Destination> {
	const raw = text(arg);
	const name = raw === null ? null : decodeFolderName(raw);
	if (name === null) throw no("Mailbox does not exist", "TRYCREATE");
	const namespace = await c.namespace();
	const folder = findFolder(namespace, name);
	if (!folder || !folder.key || !folder.mailboxId) throw no("Mailbox does not exist", "TRYCREATE");
	const mailbox = namespace.mailboxes.find((entry) => entry.id === folder.mailboxId);
	if (!mailbox) throw no("Mailbox does not exist", "TRYCREATE");
	if (!mayAddTo(mailbox.permission, folder.key)) throw no(addRefusal(mailbox.permission), "NOPERM");
	return { mailboxId: folder.mailboxId, key: folder.key, ownerUserId: mailbox.userId };
}

type Picked = { rows: MessageRow[]; uids: number[] };

/** The selected folder's messages the set names, re-read, in the order the view has them; those no longer in this folder are left out. */
async function pick(c: ImapConnection, command: ParsedCommand, uidMode: boolean, cap: number): Promise<{ picked: Picked; destArg: Arg }> {
	const [setArg, destArg, ...extra] = args(command);
	const ranges = parseSequenceSet(text(setArg) ?? "");
	if (!ranges || destArg === undefined || extra.length) throw bad("The command takes a message set and a mailbox name");
	const selected = c.selected!;
	const view = selected.view;
	const numbers = uidMode ? selectByUid(ranges, view.uids) : selectByNumber(ranges, view.exists);
	if (numbers.length > cap) throw no(`Too many messages in one command; use at most ${cap}`, "LIMIT");
	const wanted = numbers.map((msn) => ({ uid: view.uids[msn - 1], id: view.messageIds[msn - 1] }));
	const found = new Map((await loadFolderRows(c.env, selected.mailboxId, view.folderKey, wanted.map((entry) => entry.id))).map((entry) => [entry.row.id, entry.row]));
	const kept = wanted.filter((entry) => found.has(entry.id));
	return { picked: { rows: kept.map((entry) => found.get(entry.id)!), uids: kept.map((entry) => entry.uid) }, destArg };
}

/** `[COPYUID validity sources destinations]`, in the order of the messages. */
async function copyUid(c: ImapConnection, dest: Destination, picked: Picked, destIds: string[]): Promise<string | null> {
	const { uidvalidity, uids } = await uidsOf(c.env, dest.mailboxId, dest.key, destIds);
	const pairs = picked.uids.map((uid, index) => [uid, uids[index]] as const).filter((pair): pair is readonly [number, number] => pair[1] !== null);
	if (!pairs.length) return null;
	return `COPYUID ${uidvalidity} ${compactSet(pairs.map((pair) => pair[0]))} ${compactSet(pairs.map((pair) => pair[1]))}`;
}

/** A MOVE inside one mailbox is one batch; to another mailbox it is a copy there and then the source is removed: to its own Trash, or for good when it was in Trash. */
async function moveInto(c: ImapConnection, picked: Picked, dest: Destination): Promise<string[]> {
	const selected = c.selected!;
	if (dest.mailboxId === selected.mailboxId) {
		await moveMessages(c.env, c.identity!, picked.rows, dest, selected.view.folderKey as never);
		return picked.rows.map((row) => row.id);
	}
	const made = await copyMessages(c.env, c.identity!, picked.rows, dest);
	// The copies are committed. Out of Trash the source goes for good (RFC 6851: a move out of a folder is a remove there); from any other folder it goes to Trash.
	if (selected.view.folderKey === "trash") {
		await deleteUnchanged(c.env, c.identity!, picked.rows);
		return picked.rows.map((row) => made.get(row.id)!);
	}
	await moveMessages(c.env, c.identity!, picked.rows, { mailboxId: selected.mailboxId, key: "trash", ownerUserId: c.identity!.userId }, selected.view.folderKey as never);
	return picked.rows.map((row) => made.get(row.id)!);
}

export async function runMove(c: ImapConnection, command: ParsedCommand, uidMode: boolean): Promise<Completion> {
	const [setArg, destArg] = args(command);
	if (!parseSequenceSet(text(setArg) ?? "") || destArg === undefined) throw bad("MOVE takes a message set and a mailbox name");
	await c.requireWritable();
	const dest = await destination(c, destArg);
	const selected = c.selected!;
	if (dest.mailboxId === selected.mailboxId && dest.key === selected.view.folderKey) throw no("The messages are already in that folder", "CANNOT");
	const { picked } = await pick(c, command, uidMode, MAX_MOVE_MESSAGES);
	if (!picked.rows.length) return;
	const destIds = await moveInto(c, picked, dest);
	const code = await copyUid(c, dest, picked, destIds);
	if (code) c.untagged(`OK [${code}] Moved`);
	// The EXPUNGE responses for the source follow, before the tagged answer.
	c.dirty = true;
}

export async function runCopy(c: ImapConnection, command: ParsedCommand, uidMode: boolean): Promise<Completion> {
	const [setArg, destArg] = args(command);
	if (!parseSequenceSet(text(setArg) ?? "") || destArg === undefined) throw bad("COPY takes a message set and a mailbox name");
	const dest = await destination(c, destArg);
	// COPY always copies, also into Trash: a message is removed only by MOVE, or by \Deleted and EXPUNGE.
	const { picked } = await pick(c, command, uidMode, MAX_COPY_MESSAGES);
	if (!picked.rows.length) return;
	const destIds = [...(await copyMessages(c.env, c.identity!, picked.rows, dest)).values()];
	const code = await copyUid(c, dest, picked, destIds);
	return code ? { code, text: "COPY completed" } : undefined;
}

/** EXPUNGE, and UID EXPUNGE with a UID set (UIDPLUS): only what is flagged \Deleted in the selected folder, only inside the set. */
export async function runExpunge(c: ImapConnection, command: ParsedCommand, uidMode: boolean): Promise<Completion> {
	const [setArg, ...extra] = args(command);
	let only: ((uid: number) => boolean) | undefined;
	if (uidMode) {
		const ranges = parseSequenceSet(text(setArg) ?? "");
		if (!ranges || extra.length) throw bad("UID EXPUNGE takes a UID set");
		const uids = c.selected!.view.uids;
		const pairs = resolveRanges(ranges, uids.length ? uids[uids.length - 1] : 0);
		only = (uid) => pairs.some(([low, high]) => uid >= low && uid <= high);
	} else if (setArg !== undefined) throw bad("EXPUNGE takes no arguments");
	await c.requireWritable();
	const selected = c.selected!;
	await expungeDeleted(c.env, c.identity!, selected.mailboxId, selected.view.folderKey as never, only);
	// Sequence numbers may change now (RFC 3501 7.4.1), so the client is told which messages went.
	await c.pushUpdates();
	// With QRESYNC the tagged answer carries the folder's highest mod-sequence (RFC 7162 sections 3.2.7 and 3.2.9).
	if (c.qresync) return { code: `HIGHESTMODSEQ ${selected.view.highest}`, text: `${uidMode ? "UID " : ""}EXPUNGE completed` };
}

/** CLOSE of a read-write session removes the \Deleted messages first, without announcing them. */
export async function closeExpunge(c: ImapConnection): Promise<void> {
	const selected = c.selected;
	if (!selected || selected.readOnly) return;
	try {
		await c.requireMailboxWritable(selected.mailboxId);
		await expungeDeleted(c.env, c.identity!, selected.mailboxId, selected.view.folderKey as never);
	} catch (error) {
		// A login that may no longer write just closes; the messages stay flagged.
		console.warn("IMAP CLOSE could not expunge", error);
	}
}
