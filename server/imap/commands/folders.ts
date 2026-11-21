import type { ParsedCommand } from "imap-handler";
import { bad, no } from "@/lib/imap/errors";
import { createFolder, deleteFolder, renameFolders, targetOf, requireManage } from "@/lib/imap/folder-ops";
import { decodeFolderName } from "@/lib/imap/folders";
import { findFolder, type Namespace, type NamespaceFolder } from "@/lib/imap/namespace";
import type { Completion, ImapConnection } from "../connection";
import { args, text } from "./args";

/** The decoded name of a mailbox argument; a name that is not canonical modified UTF-7 cannot name anything. */
function nameOf(arg: ReturnType<typeof args>[number], code: string): string {
	const raw = text(arg);
	const name = raw === null ? null : decodeFolderName(raw);
	if (name === null) throw no(code === "NONEXISTENT" ? "Mailbox does not exist" : "The folder name is not valid", code);
	return name;
}

export function runCreate(c: ImapConnection, command: ParsedCommand): Promise<Completion> {
	return (async () => {
		const [nameArg, ...extra] = args(command);
		if (!nameArg || extra.length) throw bad("CREATE takes one mailbox name");
		const name = nameOf(nameArg, "CANNOT");
		await createFolder(c.env, c.identity!, await c.namespace(), name);
	})();
}

/** The user folder a name refers to, or the reason it is not one that can be changed. */
function userFolder(namespace: Namespace, name: string, what: "deleted" | "renamed"): NamespaceFolder & { key: `f:${string}`; mailboxId: string } {
	const folder = findFolder(namespace, name);
	if (!folder || !folder.key || !folder.mailboxId) throw no("Mailbox does not exist", "NONEXISTENT");
	if (!folder.key.startsWith("f:")) throw no(`System folders cannot be ${what}`, "CANNOT");
	return folder as NamespaceFolder & { key: `f:${string}`; mailboxId: string };
}

export async function runDelete(c: ImapConnection, command: ParsedCommand): Promise<Completion> {
	const [nameArg, ...extra] = args(command);
	if (!nameArg || extra.length) throw bad("DELETE takes one mailbox name");
	const namespace = await c.namespace();
	const folder = userFolder(namespace, nameOf(nameArg, "NONEXISTENT"), "deleted");
	const mailbox = namespace.mailboxes.find((entry) => entry.id === folder.mailboxId)!;
	await deleteFolder(c.env, c.identity!, mailbox, folder.key.slice(2));
	// Its messages moved to Trash, so a session that has the folder open hears about it.
	if (c.selected?.mailboxId === folder.mailboxId) c.dirty = true;
}

export async function runRename(c: ImapConnection, command: ParsedCommand): Promise<Completion> {
	const [fromArg, toArg, ...extra] = args(command);
	if (!fromArg || !toArg || extra.length) throw bad("RENAME takes two mailbox names");
	const from = nameOf(fromArg, "NONEXISTENT");
	const to = nameOf(toArg, "CANNOT");
	const namespace = await c.namespace();
	const found = findFolder(namespace, from);
	if (!found) throw no("Mailbox does not exist", "NONEXISTENT");
	let mailbox;
	let local: string;
	let fromId: string | null = null;
	if (found.key) {
		if (!found.key.startsWith("f:")) throw no("System folders cannot be renamed", "CANNOT");
		mailbox = namespace.mailboxes.find((entry) => entry.id === found.mailboxId)!;
		fromId = found.key.slice(2);
		local = found.name;
	} else {
		// A placeholder: only the folders below it exist, and they are what is renamed.
		({ mailbox, local } = targetOf(namespace, from));
		if (!local) throw no("Mailbox does not exist", "NONEXISTENT");
	}
	const destination = targetOf(namespace, to);
	if (destination.mailbox.id !== mailbox.id) throw no("A folder cannot be moved to another mailbox", "CANNOT");
	requireManage(mailbox);
	const prefix = mailbox.id === namespace.personal.id ? "" : `Shared/${`${mailbox.localPart}@${mailbox.hostname}`.toLowerCase()}/`;
	await renameFolders(c.env, mailbox, fromId ? found.name.slice(prefix.length) : local, fromId, destination.local);
	if (c.selected?.mailboxId === mailbox.id) c.dirty = true;
}

/** SUBSCRIBE and UNSUBSCRIBE: every folder is subscribed (spec 6.2), so they answer OK and keep nothing. */
export function runSubscribe(command: ParsedCommand): Completion {
	const [nameArg, ...extra] = args(command);
	if (!nameArg || extra.length || text(nameArg) === null) throw bad("The command takes one mailbox name");
}
