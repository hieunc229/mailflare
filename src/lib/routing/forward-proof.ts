import type { AppDatabase } from "@/db";
import { getEmailAddress } from "@/lib/email/address";
import { resolveInboundAddress } from "@/lib/email/routing";
import { listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";

/**
 * A forward rule copies mail to another address, so setting one that leaves the user's own
 * mailboxes needs fresh proof, like the other sensitive account changes.
 *
 * An address is internal only when mail to it would be stored in a mailbox the user can access
 * (an exact mailbox, an alias, or a catch-all that stores there). Owning the domain is not enough:
 * an unclaimed address on it may be routed anywhere, including outside.
 */
export async function isExternalForwardTarget(db: AppDatabase, user: Pick<SessionUser, "id" | "email" | "role">, forwardTo: string): Promise<boolean> {
	const address = getEmailAddress(forwardTo).trim().toLowerCase();
	if (address.lastIndexOf("@") < 1) return true;
	const decision = await resolveInboundAddress(db, address);
	if (decision?.action !== "store" || !decision.mailbox) return true;
	return !(await listAccessibleMailboxIds(db, user)).includes(decision.mailbox.mailboxId);
}

type RuleShape = {
	action: string;
	forwardTo: string | null;
	matchField?: string | null;
	matchOperator?: string | null;
	matchValue?: string | null;
	enabled?: boolean | null;
	mailboxId?: string | null;
};

/**
 * True when the rule ends up forwarding somewhere or to something it did not before: a new or
 * different target, the same forward with different match criteria (widening "to: sales" into
 * "*" would copy far more mail to the same outside address), a disabled forward switched back on,
 * or a different copy mailbox.
 */
export function forwardTargetChanged(existing: RuleShape | null, next: { action: string; forwardTo?: string | null } & Omit<RuleShape, "action" | "forwardTo">): boolean {
	if (next.action !== "forward" || !next.forwardTo) return false;
	if (existing?.action !== "forward") return true;
	if ((existing.forwardTo ?? "").trim().toLowerCase() !== next.forwardTo.trim().toLowerCase()) return true;
	if (existing.enabled === false && next.enabled === true) return true;
	if (next.mailboxId !== undefined && (existing.mailboxId ?? "") !== (next.mailboxId ?? "")) return true;
	return (existing.matchField ?? "") !== (next.matchField ?? "")
		|| (existing.matchOperator ?? "") !== (next.matchOperator ?? "")
		|| (existing.matchValue ?? "").trim() !== (next.matchValue ?? "").trim();
}
