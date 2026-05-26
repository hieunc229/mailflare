import { eq, and, desc } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, routingRules } from "@/db/schema";
import { parseAddress } from "@/lib/utils";

export type ResolvedMailbox = {
	mailboxId: string;
	userId: string;
	domainId: string;
};

export type RoutingDecision = {
	action: "store" | "forward" | "reject";
	mailbox?: ResolvedMailbox;
	forwardTo?: string;
};

export async function resolveInboundAddress(
	db: AppDatabase,
	toAddress: string,
): Promise<RoutingDecision | null> {
	const parsed = parseAddress(toAddress);
	if (!parsed) return null;

	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")))
		.limit(1);

	if (!domain) return null;

	const rules = await db
		.select()
		.from(routingRules)
		.where(eq(routingRules.domainId, domain.id))
		.orderBy(desc(routingRules.priority));

	for (const rule of rules) {
		if (rule.pattern === "*" || rule.pattern === parsed.local || rule.pattern === toAddress) {
			if (rule.action === "reject") return { action: "reject" };
			if (rule.action === "forward" && rule.forwardTo) {
				return { action: "forward", forwardTo: rule.forwardTo };
			}
			if (rule.mailboxId) {
				return {
					action: "store",
					mailbox: {
						mailboxId: rule.mailboxId,
						userId: domain.userId,
						domainId: domain.id,
					},
				};
			}
		}
	}

	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, parsed.local)))
		.limit(1);

	if (!mailbox) return null;

	return {
		action: "store",
		mailbox: {
			mailboxId: mailbox.id,
			userId: mailbox.userId,
			domainId: domain.id,
		},
	};
}
