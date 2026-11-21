import { listFoldersByMailbox, listJmapMailboxes } from "@/lib/jmap/access";
import type { AccessibleMailbox } from "@/lib/jmap/types";
import { imapContext, type ImapIdentity } from "./auth";
import { listFolders, type FolderKey } from "./folders";

/**
 * Everything a login can see, as IMAP folder names (spec section 7). The login
 * mailbox is the personal namespace; every other mailbox the user may access and
 * the app password's mailbox scope allows is under `Shared/<address>/`. The list
 * comes from the access layer on every call, so a delegation that was removed, a
 * mailbox that was disabled and a narrowed key scope take effect on the next
 * command; nothing outside the list can be named, selected or fetched.
 */
export type NamespaceFolder = {
	/** UTF-8 name, hierarchy delimiter `/`. */
	name: string;
	/** The Mailflare mailbox the folder is in; null for a placeholder that exists only as a parent. */
	mailboxId: string | null;
	key: FolderKey | null;
	attributes: string[];
	permission: AccessibleMailbox["permission"] | null;
};

export type Namespace = {
	personal: AccessibleMailbox;
	mailboxes: AccessibleMailbox[];
	folders: NamespaceFolder[];
};

export const SHARED_PREFIX = "Shared";

export const mailboxAddress = (mailbox: Pick<AccessibleMailbox, "localPart" | "hostname">) => `${mailbox.localPart}@${mailbox.hostname}`.toLowerCase();

/** A user folder may not be named like the shared namespace, or its messages could be mistaken for a delegated mailbox's. */
const clearOfSharedName = (name: string) => (name === SHARED_PREFIX || name.startsWith(`${SHARED_PREFIX}/`) ? `${SHARED_PREFIX} (folder)${name.slice(SHARED_PREFIX.length)}` : name);

export async function loadNamespace(env: CloudflareEnv, identity: ImapIdentity): Promise<Namespace | null> {
	const ctx = imapContext(env, identity.auth);
	const mailboxes = await listJmapMailboxes(ctx);
	const personal = mailboxes.find((mailbox) => mailbox.id === identity.loginMailboxId);
	if (!personal) return null;
	const userFolders = await listFoldersByMailbox(ctx, mailboxes.map((mailbox) => mailbox.id));
	const folders: NamespaceFolder[] = [];
	for (const entry of listFolders((userFolders.get(personal.id) ?? []).map((folder) => ({ ...folder, name: clearOfSharedName(folder.name) })))) {
		folders.push({ name: entry.name, mailboxId: entry.key ? personal.id : null, key: entry.key, attributes: entry.attributes, permission: entry.key ? personal.permission : null });
	}
	const others = mailboxes.filter((mailbox) => mailbox.id !== personal.id).sort((a, b) => (mailboxAddress(a) < mailboxAddress(b) ? -1 : mailboxAddress(a) > mailboxAddress(b) ? 1 : 0));
	if (others.length) folders.push({ name: SHARED_PREFIX, mailboxId: null, key: null, attributes: ["\\Noselect", "\\HasChildren"], permission: null });
	for (const mailbox of others) {
		const prefix = `${SHARED_PREFIX}/${mailboxAddress(mailbox)}`;
		folders.push({ name: prefix, mailboxId: null, key: null, attributes: ["\\Noselect", "\\HasChildren"], permission: null });
		for (const entry of listFolders(userFolders.get(mailbox.id) ?? [])) {
			folders.push({ name: `${prefix}/${entry.name}`, mailboxId: entry.key ? mailbox.id : null, key: entry.key, attributes: entry.attributes, permission: entry.key ? mailbox.permission : null });
		}
	}
	return { personal, mailboxes, folders };
}

/** The folder a client's (decoded) name refers to. INBOX and its children are case-insensitive in the first segment only. */
export function findFolder(namespace: Namespace, requested: string): NamespaceFolder | null {
	const inbox = (name: string) => (name.toUpperCase() === "INBOX" ? "INBOX" : name.slice(0, 6).toUpperCase() === "INBOX/" ? `INBOX${name.slice(5)}` : name);
	let name = inbox(requested);
	if (requested.slice(0, SHARED_PREFIX.length + 1).toLowerCase() === `${SHARED_PREFIX.toLowerCase()}/`) {
		const [, address = "", ...rest] = requested.split("/");
		name = [SHARED_PREFIX, address.toLowerCase(), ...(rest.length ? [inbox(rest.join("/"))] : [])].join("/");
	}
	return namespace.folders.find((folder) => folder.name === name) ?? null;
}

/** Whether a mailbox is still in the list: what a session re-checks before it touches that mailbox's data. */
export async function canStillSee(env: CloudflareEnv, identity: ImapIdentity, mailboxId: string): Promise<boolean> {
	return (await listJmapMailboxes(imapContext(env, identity.auth))).some((mailbox) => mailbox.id === mailboxId);
}
