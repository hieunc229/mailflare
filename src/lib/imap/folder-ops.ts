import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { encodeMailboxRef } from "@/lib/jmap/ids";
import type { AccessibleMailbox } from "@/lib/jmap/types";
import type { ImapIdentity } from "./auth";
import { no } from "./errors";
import { jmapCall } from "./flags";
import { keyOfSystemFolderName } from "./folders";
import { SHARED_PREFIX, mailboxAddress, type Namespace } from "./namespace";

/**
 * CREATE, DELETE and RENAME of user folders (spec 7.2). Mailflare folders are flat, so `Clients/Acme` is one folder
 * with that name and the parent only appears as a placeholder in LIST. Creating and deleting go through the JMAP
 * `Mailbox/set` handler (full access needed, deleting moves the messages to Trash); a rename of a folder with
 * folders below it changes all of them in one batch.
 */
export const MAX_FOLDER_NAME = 80;
export const MAX_FOLDER_DEPTH = 10;
export const MAX_FOLDERS_PER_MAILBOX = 500;

const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f*%\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;

/** INBOX is the one name that is not case-sensitive, and a first segment spelled `inbox` is the real INBOX's child. */
export function canonicalName(name: string): string {
	const cut = name.indexOf("/");
	const first = cut < 0 ? name : name.slice(0, cut);
	return first.toUpperCase() === "INBOX" ? `INBOX${cut < 0 ? "" : name.slice(cut)}` : name;
}

/** The folder name a client asked for, checked: flat, at most 80 characters and 10 levels, no empty or dot segments, no wildcards or control characters. */
export function checkFolderName(requested: string): { name: string; hierarchyOnly: boolean } {
	const hierarchyOnly = requested.endsWith("/");
	const name = canonicalName(hierarchyOnly ? requested.slice(0, -1) : requested);
	const segments = name.split("/");
	if (!name || name.length > MAX_FOLDER_NAME) throw no("The folder name is empty or longer than 80 characters", "CANNOT");
	if (segments.length > MAX_FOLDER_DEPTH) throw no("The folder name has too many levels", "CANNOT");
	for (const segment of segments) {
		if (!segment || segment === "." || segment === ".." || segment !== segment.trim() || FORBIDDEN_CHARS.test(segment)) throw no("The folder name is not valid", "CANNOT");
	}
	return { name, hierarchyOnly };
}

export type Target = { mailbox: AccessibleMailbox; local: string };

/** The mailbox a name belongs to and the folder name inside it: `Shared/<address>/<name>` for a delegated or other personal mailbox, the login mailbox otherwise. */
export function targetOf(namespace: Namespace, name: string): Target {
	const parts = name.split("/");
	if (parts[0].toLowerCase() === SHARED_PREFIX.toLowerCase()) {
		if (parts.length < 3) throw no("That name is reserved", "CANNOT");
		const mailbox = namespace.mailboxes.find((entry) => entry.id !== namespace.personal.id && mailboxAddress(entry) === parts[1].toLowerCase());
		if (!mailbox) throw no("There is no such shared mailbox", "CANNOT");
		return { mailbox, local: parts.slice(2).join("/") };
	}
	return { mailbox: namespace.personal, local: name };
}

export function requireManage(mailbox: AccessibleMailbox): void {
	if (mailbox.permission !== "full_access") throw no("You may not change folders in this mailbox", "NOPERM");
}

type StoredFolder = { id: string; name: string };
async function storedFolders(env: CloudflareEnv, mailboxId: string): Promise<StoredFolder[]> {
	return getDb(env).select({ id: folders.id, name: folders.name }).from(folders).where(eq(folders.mailboxId, mailboxId));
}

/** Creates the folder; false when the name only announced children (a trailing delimiter) and nothing was made. */
export async function createFolder(env: CloudflareEnv, identity: ImapIdentity, namespace: Namespace, requested: string): Promise<boolean> {
	const { mailbox, local } = targetOf(namespace, requested);
	const { name, hierarchyOnly } = checkFolderName(local);
	requireManage(mailbox);
	if (keyOfSystemFolderName(name)) throw no("Mailbox already exists", "ALREADYEXISTS");
	const existing = await storedFolders(env, mailbox.id);
	if (existing.some((folder) => canonicalName(folder.name) === name)) throw no("Mailbox already exists", "ALREADYEXISTS");
	if (hierarchyOnly) return false;
	if (existing.length >= MAX_FOLDERS_PER_MAILBOX) throw no("Too many folders in this mailbox", "LIMIT");
	const result = (await jmapCall(env, identity, "Mailbox/set", { create: { f: { name, parentId: mailbox.id } } })) as { created?: Record<string, unknown>; notCreated?: Record<string, { description?: string }> };
	if (!result.created?.f) {
		if (result.notCreated?.f?.description?.includes("already exists")) throw no("Mailbox already exists", "ALREADYEXISTS");
		throw no("The folder could not be created", "SERVERBUG");
	}
	return true;
}

/** Deletes a user folder; its messages go to Trash first (the JMAP rule), so nothing is destroyed with it. */
export async function deleteFolder(env: CloudflareEnv, identity: ImapIdentity, mailbox: AccessibleMailbox, folderId: string): Promise<void> {
	requireManage(mailbox);
	const id = encodeMailboxRef({ kind: "folder", mailboxId: mailbox.id, folderId });
	const result = (await jmapCall(env, identity, "Mailbox/set", { destroy: [id], onDestroyRemoveEmails: true })) as { destroyed?: string[]; notDestroyed?: Record<string, { type?: string }> };
	if (result.destroyed?.includes(id)) return;
	const type = result.notDestroyed?.[id]?.type;
	if (type === "forbidden") throw no("You may not change folders in this mailbox", "NOPERM");
	if (type === "notFound") throw no("Mailbox does not exist", "NONEXISTENT");
	throw no("The folder could not be deleted", "SERVERBUG");
}

/**
 * Renames a folder (`from` is the folder, or null for a placeholder) and every folder below it. All new names are
 * checked before anything changes, and the folders are written in one batch.
 */
export async function renameFolders(env: CloudflareEnv, mailbox: AccessibleMailbox, fromName: string, fromId: string | null, toLocal: string): Promise<void> {
	requireManage(mailbox);
	const { name: to } = checkFolderName(toLocal);
	const stored = await storedFolders(env, mailbox.id);
	const base = fromId ? stored.find((folder) => folder.id === fromId)?.name : fromName;
	if (base === undefined) throw no("Mailbox does not exist", "NONEXISTENT");
	const below = stored.filter((folder) => canonicalName(folder.name).startsWith(`${canonicalName(base)}/`));
	const moving = [...(fromId ? stored.filter((folder) => folder.id === fromId) : []), ...below];
	if (!moving.length) throw no("Mailbox does not exist", "NONEXISTENT");
	const plan = moving.map((folder) => {
		const old = canonicalName(folder.name);
		const next = old === canonicalName(base) ? to : `${to}${old.slice(canonicalName(base).length)}`;
		return { id: folder.id, name: checkFolderName(next).name, old };
	});
	const staying = new Set(stored.filter((folder) => !plan.some((entry) => entry.id === folder.id)).map((folder) => canonicalName(folder.name)));
	for (const entry of plan) if (keyOfSystemFolderName(entry.name) || staying.has(entry.name)) throw no("Mailbox already exists", "ALREADYEXISTS");
	if (new Set(plan.map((entry) => entry.name)).size !== plan.length) throw no("Mailbox already exists", "ALREADYEXISTS");
	const db = getDb(env);
	// Deepest first, so a folder is never renamed to a name another folder of the plan still holds.
	const ordered = [...plan].sort((a, b) => b.old.length - a.old.length);
	await db.batch(ordered.map((entry) => db.update(folders).set({ name: entry.name }).where(and(eq(folders.id, entry.id), eq(folders.mailboxId, mailbox.id)))) as never);
}
