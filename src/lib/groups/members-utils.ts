import { MAX_EXTERNAL_MEMBERS } from "@/lib/groups/relay-utils";

export { MAX_EXTERNAL_MEMBERS };
export const MAX_GROUP_MEMBERS = 500;
/** The member flag exists in the schema, but sending as a group arrives with a later change. */
export const CAN_SEND_AS_UNAVAILABLE = "Sending as the group is not available yet";
export const MAX_GROUPS_PER_DOMAIN = 50;
export const MAX_MEMBERS_PER_CALL = 50;
/** Rows per insert: 9 bound parameters each, far under D1's 100 per statement. */
export const MEMBER_INSERT_CHUNK = 10;

export type MemberInput = {
	kind: "user" | "mailbox" | "external";
	userId?: string;
	mailboxId?: string;
	email?: string;
	canSendAs?: boolean;
};

export type ValidMember =
	| { kind: "user"; userId: string; canSendAs: boolean }
	| { kind: "mailbox"; mailboxId: string; canSendAs: false }
	| { kind: "external"; email: string; canSendAs: false };

export const INVALID_EXTERNAL_EMAIL = "Enter a valid email address";

/** One plain `local@domain.tld`: no display name, quotes, spaces or lists, so it is safe in a To header. */
export function normalizeExternalEmail(value: string): string | null {
	const email = value.trim().toLowerCase();
	if (email.length > 320 || !/^[^\s@<>,;:"()\[\]\\]+@[^\s@<>,;:"()\[\]\\]+\.[^\s@<>,;:"()\[\]\\.]+$/.test(email)) return null;
	const [local, domain] = email.split("@");
	if (local.length > 64 || domain.startsWith(".") || domain.includes("..")) return null;
	return email;
}

export type MemberValidation =
	| { ok: true; member: ValidMember }
	| { ok: false; status: 400 | 422; error: string };

/**
 * A member row has exactly one of user_id, mailbox_id or email, matching its kind (spec D-2). Checks that
 * need the database (own domains, the group's own address, caps) are the service's.
 */
export function validateMember(input: MemberInput): MemberValidation {
	const set = [input.userId, input.mailboxId, input.email].filter((value) => value !== undefined && value !== null).length;
	if (input.canSendAs) return { ok: false, status: 422, error: CAN_SEND_AS_UNAVAILABLE };
	if (input.kind === "user") {
		if (!input.userId || set !== 1) return { ok: false, status: 400, error: "A user member needs a userId and nothing else" };
		return { ok: true, member: { kind: "user", userId: input.userId, canSendAs: false } };
	}
	if (input.kind === "mailbox") {
		if (!input.mailboxId || set !== 1) return { ok: false, status: 400, error: "A mailbox member needs a mailboxId and nothing else" };
		return { ok: true, member: { kind: "mailbox", mailboxId: input.mailboxId, canSendAs: false } };
	}
	if (input.kind === "external") {
		if (!input.email || set !== 1) return { ok: false, status: 400, error: "An external member needs an email and nothing else" };
		const email = normalizeExternalEmail(input.email);
		if (!email) return { ok: false, status: 422, error: INVALID_EXTERNAL_EMAIL };
		return { ok: true, member: { kind: "external", email, canSendAs: false } };
	}
	return { ok: false, status: 400, error: "Unknown member kind" };
}

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}

export function groupAddress(localPart: string, hostname: string): string {
	return `${localPart}@${hostname}`.toLowerCase();
}
