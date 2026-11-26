import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mailGroups } from "@/db/schema";
import { ensureEmailRoutingRuleToWorker, type EmailRoutingRuleCache } from "@/lib/cloudflare-api";
import { isMissingTableError } from "@/lib/database-errors";

/**
 * Puts the Worker route of every group address on this domain back. Removing Cloudflare receiving
 * deletes every rule of the domain, and groups made while another provider received have none yet,
 * so switching to Cloudflare must recreate them like the mailbox routes. Paused groups keep their
 * rule: the Worker rejects their mail, and resuming needs no routing change.
 */
export async function ensureGroupDomainRouting(
	env: CloudflareEnv,
	db: AppDatabase,
	domain: { id: string; hostname: string; zoneId: string },
	ruleCache: EmailRoutingRuleCache,
): Promise<void> {
	let rows: { localPart: string }[];
	try {
		rows = await db.select({ localPart: mailGroups.localPart }).from(mailGroups).where(eq(mailGroups.domainId, domain.id));
	} catch (error) {
		// Receiving has already switched when this runs, so a failed lookup must not fail the whole setup.
		if (!isMissingTableError(error)) console.warn("Listing groups to restore their routing rules failed", error);
		return;
	}
	const results = await Promise.allSettled(rows.map((row) => ensureEmailRoutingRuleToWorker(env, domain.zoneId, `${row.localPart}@${domain.hostname}`.toLowerCase(), undefined, ruleCache)));
	for (const result of results) if (result.status === "rejected") console.warn("Restoring a group routing rule failed", result.reason);
}
