export const MAX_GROUP_MEMBERS = 500;
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

export type MemberValidation =
	| { ok: true; member: { kind: "user"; userId: string; canSendAs: boolean } | { kind: "mailbox"; mailboxId: string; canSendAs: false } }
	| { ok: false; status: 400 | 422; error: string };

/**
 * A member row has exactly one of user_id, mailbox_id or email, matching its kind (spec D-2). External
 * members arrive with the relay change, so they are refused here until then.
 */
export function validateMember(input: MemberInput): MemberValidation {
	const set = [input.userId, input.mailboxId, input.email].filter((value) => value !== undefined && value !== null).length;
	if (input.kind === "external") return { ok: false, status: 422, error: "External members are not supported yet" };
	if (input.kind === "user") {
		if (!input.userId || set !== 1) return { ok: false, status: 400, error: "A user member needs a userId and nothing else" };
		return { ok: true, member: { kind: "user", userId: input.userId, canSendAs: input.canSendAs === true } };
	}
	if (input.kind === "mailbox") {
		if (!input.mailboxId || set !== 1) return { ok: false, status: 400, error: "A mailbox member needs a mailboxId and nothing else" };
		if (input.canSendAs) return { ok: false, status: 400, error: "Only account members can be allowed to send as the group" };
		return { ok: true, member: { kind: "mailbox", mailboxId: input.mailboxId, canSendAs: false } };
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
