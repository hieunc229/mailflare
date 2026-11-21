import type { SQL } from "drizzle-orm";
import { mailboxIdsFor } from "@/lib/jmap/email-objects";
import { mailboxRefCondition } from "@/lib/jmap/email-query";
import { SYSTEM_ROLES, decodeMailboxRef } from "@/lib/jmap/ids";
import type { MailboxRef, SystemRole } from "@/lib/jmap/types";

/**
 * IMAP folders of one Mailflare mailbox. A folder key is a system role
 * (`inbox`, `sent`, ...) or `f:<folderId>`; it is what the state tables store.
 * The folder membership rules are not repeated here: `folderKeyOf` decodes the
 * single JMAP mailbox id of a row and `folderKeyCondition` reuses the JMAP query
 * predicate, so IMAP and JMAP cannot disagree about where a message lives.
 */
export type FolderKey = SystemRole | `f:${string}`;

type FolderRow = Parameters<typeof mailboxIdsFor>[0];

/** The one folder a message is in, or null when it is in none (no mailbox, or a status JMAP does not list). */
export function folderKeyOf(row: FolderRow): FolderKey | null {
	const [id] = Object.keys(mailboxIdsFor(row));
	const ref = id ? decodeMailboxRef(id) : null;
	if (ref?.kind === "role") return ref.role;
	if (ref?.kind === "folder") return `f:${ref.folderId}`;
	return null;
}

export function folderRefOfKey(mailboxId: string, key: string): MailboxRef | null {
	if ((SYSTEM_ROLES as string[]).includes(key)) return { kind: "role", mailboxId, role: key as SystemRole };
	if (key.startsWith("f:") && key.length > 2) return { kind: "folder", mailboxId, folderId: key.slice(2) };
	return null;
}

/** SQL predicate on `messages` for "is in this folder". */
export function folderKeyCondition(mailboxId: string, key: string): SQL | null {
	const ref = folderRefOfKey(mailboxId, key);
	return ref ? mailboxRefCondition(ref) : null;
}

// ---- Names ----

/** Fixed English names: mail apps rely on the special-use attribute, and fixed names keep server state locale-independent. */
const SYSTEM_FOLDERS: Record<SystemRole, { name: string; specialUse: string | null }> = {
	inbox: { name: "INBOX", specialUse: null },
	sent: { name: "Sent", specialUse: "\\Sent" },
	drafts: { name: "Drafts", specialUse: "\\Drafts" },
	archive: { name: "Archive", specialUse: "\\Archive" },
	junk: { name: "Junk", specialUse: "\\Junk" },
	trash: { name: "Trash", specialUse: "\\Trash" },
};

export function systemFolderName(role: SystemRole): string {
	return SYSTEM_FOLDERS[role].name;
}

/** Only INBOX is case-insensitive (RFC 3501 5.1). */
export function keyOfSystemFolderName(name: string): SystemRole | null {
	if (name.toUpperCase() === "INBOX") return "inbox";
	return SYSTEM_ROLES.find((role) => role !== "inbox" && SYSTEM_FOLDERS[role].name === name) ?? null;
}

export type FolderListing = { name: string; key: FolderKey | null; attributes: string[] };

/**
 * The folders of one mailbox as IMAP names, hierarchy delimiter `/`. Mailflare
 * folders are flat, so `Clients/Acme` is one folder; a missing parent gets a
 * `\Noselect` placeholder (never one with an empty segment). Every listed name is
 * unique: a user folder named like a system folder is listed as `<name> (folder)`,
 * a first segment spelled `inbox` in any case becomes `INBOX` (IMAP's one
 * case-insensitive name, so those folders are children of the real INBOX), and any
 * remaining duplicate gets ` (<folder id>)`. Folders are named in id order, so a
 * folder keeps its name whatever order the caller passes them in.
 */
export function listFolders(userFolders: Array<{ id: string; name: string }>): FolderListing[] {
	const entries: Array<{ name: string; key: FolderKey | null; attributes: string[] }> = SYSTEM_ROLES.map((role) => ({
		name: SYSTEM_FOLDERS[role].name,
		key: role,
		attributes: SYSTEM_FOLDERS[role].specialUse ? [SYSTEM_FOLDERS[role].specialUse] : [],
	}));
	const taken = new Set(entries.map((entry) => entry.name));
	const listedName = new Map<string, string>();
	for (const folder of [...userFolders].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		let name = folder.name;
		if (keyOfSystemFolderName(name)) name = `${name} (folder)`;
		else if (name.slice(0, 6).toUpperCase() === "INBOX/") name = `INBOX${name.slice(5)}`;
		while (taken.has(name)) name = `${name} (${folder.id})`;
		taken.add(name);
		listedName.set(folder.id, name);
	}
	for (const folder of userFolders) entries.push({ name: listedName.get(folder.id)!, key: `f:${folder.id}`, attributes: [] });
	const real = new Set(entries.map((entry) => entry.name));
	for (const { name } of entries.slice(SYSTEM_ROLES.length)) {
		const segments = name.split("/");
		for (let depth = 1; depth < segments.length; depth += 1) {
			if (segments[depth - 1] === "") continue;
			const parent = segments.slice(0, depth).join("/");
			if (!real.has(parent)) {
				real.add(parent);
				entries.push({ name: parent, key: null, attributes: ["\\Noselect"] });
			}
		}
	}
	const parents = new Set<string>();
	for (const { name } of entries) {
		const cut = name.lastIndexOf("/");
		if (cut > 0) parents.add(name.slice(0, cut));
	}
	return entries.map((entry) => ({ ...entry, attributes: [...entry.attributes, parents.has(entry.name) ? "\\HasChildren" : "\\HasNoChildren"] }));
}

// ---- Modified UTF-7 (RFC 3501 5.1.3) ----

const isPrintableAscii = (unit: number) => unit >= 0x20 && unit <= 0x7e;

/** Mailflare's UTF-8 folder name as an IMAP4rev1 mailbox name. */
export function encodeFolderName(name: string): string {
	let out = "";
	let run: number[] = [];
	const flush = () => {
		if (!run.length) return;
		const bytes = Buffer.alloc(run.length * 2);
		run.forEach((unit, index) => bytes.writeUInt16BE(unit, index * 2));
		out += `&${bytes.toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`;
		run = [];
	};
	for (let index = 0; index < name.length; index += 1) {
		const unit = name.charCodeAt(index);
		if (isPrintableAscii(unit)) {
			flush();
			out += unit === 0x26 ? "&-" : name[index];
		} else if (unit >= 0xd800 && unit <= 0xdbff && name.charCodeAt(index + 1) >= 0xdc00 && name.charCodeAt(index + 1) <= 0xdfff) {
			run.push(unit, name.charCodeAt(index + 1));
			index += 1;
		} else if (unit >= 0xd800 && unit <= 0xdfff) {
			// A lone surrogate is not text; the decoder would reject it, so send U+FFFD.
			run.push(0xfffd);
		} else run.push(unit);
	}
	flush();
	return out;
}

/** An IMAP4rev1 mailbox name as UTF-8, or null when it is not canonical modified UTF-7. */
export function decodeFolderName(encoded: string): string | null {
	let out = "";
	let afterRun = false;
	for (let index = 0; index < encoded.length; ) {
		const char = encoded[index];
		if (char !== "&") {
			if (!isPrintableAscii(encoded.charCodeAt(index))) return null;
			out += char;
			index += 1;
			afterRun = false;
			continue;
		}
		const end = encoded.indexOf("-", index);
		if (end < 0) return null;
		const body = encoded.slice(index + 1, end);
		index = end + 1;
		if (body === "") {
			out += "&";
			afterRun = false;
			continue;
		}
		// Two runs in a row would have been one run: not the form the encoder writes.
		if (afterRun) return null;
		afterRun = true;
		if (!/^[A-Za-z0-9+,]+$/.test(body)) return null;
		const base64 = body.replace(/,/g, "/");
		const bytes = Buffer.from(base64, "base64");
		// Whole UTF-16 units only, and no stray bits in the last character: re-encoding must give the input back.
		if (bytes.length % 2 !== 0 || bytes.toString("base64").replace(/=+$/, "") !== base64) return null;
		const units: number[] = [];
		for (let at = 0; at + 1 < bytes.length; at += 2) units.push(bytes.readUInt16BE(at));
		if (!units.length || units.some(isPrintableAscii)) return null;
		let text = "";
		for (let at = 0; at < units.length; at += 1) {
			const unit = units[at];
			if (unit >= 0xd800 && unit <= 0xdbff) {
				const next = units[at + 1];
				if (next === undefined || next < 0xdc00 || next > 0xdfff) return null;
				text += String.fromCharCode(unit, next);
				at += 1;
			} else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
			else text += String.fromCharCode(unit);
		}
		out += text;
	}
	return out;
}
