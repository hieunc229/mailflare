import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailGroupMembers, mailGroups } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { markerSecret } from "@/lib/email/account-forwarding";
import { unsubscribePage } from "@/lib/groups/unsubscribe-page";
import { verifyUnsubscribeToken, type UnsubscribeClaim } from "@/lib/groups/unsubscribe-token";
import { createAuditLog } from "@/lib/mailboxes/audit";

type Context = { params: Promise<{ token: string }> };

/** The claim a link proves, or null. Everything that is not a validly signed token is the same 404. */
async function claimOf(env: CloudflareEnv, context: Context): Promise<UnsubscribeClaim | null> {
	const secret = markerSecret(env);
	if (!secret) return null;
	return verifyUnsubscribeToken(secret, (await context.params).token);
}

const notFound = () => unsubscribePage({ status: 404, title: "Link not valid", message: "This unsubscribe link is not valid." });

/**
 * Public. The signed token is the whole credential: it names one group, one member row and one address, so
 * it cannot be re-aimed, and nothing here reveals who is in a group. A mail scanner or link preview that
 * fetches the URL only reaches this confirmation page: the change happens on POST.
 */
export async function GET(_request: Request, context: Context) {
	const env = getEnv();
	const claim = await claimOf(env, context);
	if (!claim) return notFound();
	let name = "this group";
	try {
		const [group] = await getDb(env).select({ name: mailGroups.name }).from(mailGroups).where(eq(mailGroups.id, claim.groupId)).limit(1);
		if (group) name = group.name;
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
	}
	return unsubscribePage({
		status: 200,
		title: "Unsubscribe",
		message: `Stop receiving mail sent to ${name} at ${claim.email}?`,
		action: { path: `/api/groups/unsubscribe/${encodeURIComponent((await context.params).token)}`, label: "Unsubscribe" },
	});
}

/** The confirm button, and the RFC 8058 one-click POST (`List-Unsubscribe=One-Click`) from the mail client. */
export async function POST(_request: Request, context: Context) {
	const env = getEnv();
	const claim = await claimOf(env, context);
	if (!claim) return notFound();
	const db = getDb(env);
	try {
		// The row must match all three claims, so a validly signed token never touches anyone else's membership.
		const [row] = await db
			.select({ id: mailGroupMembers.id, localPart: mailGroups.localPart, hostname: domains.hostname })
			.from(mailGroupMembers)
			.innerJoin(mailGroups, eq(mailGroupMembers.groupId, mailGroups.id))
			.innerJoin(domains, eq(mailGroups.domainId, domains.id))
			.where(and(
				eq(mailGroupMembers.id, claim.memberId),
				eq(mailGroupMembers.groupId, claim.groupId),
				eq(mailGroupMembers.kind, "external"),
				eq(mailGroupMembers.email, claim.email),
			))
			.limit(1);
		if (row) {
			await db.delete(mailGroupMembers).where(eq(mailGroupMembers.id, row.id));
			await createAuditLog(env, {
				actorUserId: null,
				action: "group.member_unsubscribed",
				metadata: { groupId: claim.groupId, address: `${row.localPart}@${row.hostname}`.toLowerCase(), kind: "external", email: claim.email },
			});
		}
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
	}
	// The same answer whether or not a row was removed: a link must not tell its holder who else is, or was, a member.
	return unsubscribePage({ status: 200, title: "Unsubscribed", message: "You have been unsubscribed. You will not receive further mail from this group." });
}
