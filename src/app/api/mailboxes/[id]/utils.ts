import { eq } from "drizzle-orm";
import { domains, mailboxes } from "@/db/schema";
import type { getDb } from "@/db";
import type { MailboxUpdateValues } from "./types";

type Db = ReturnType<typeof getDb>;

export function selectMailboxForUser(db: Db, userId: string, mailboxId: string) {
	return db
		.select({
			id: mailboxes.id,
			userId: mailboxes.userId,
			domainId: mailboxes.domainId,
			localPart: mailboxes.localPart,
			displayName: mailboxes.displayName,
			forwardTo: mailboxes.forwardTo,
			type: mailboxes.type,
			disabled: mailboxes.disabled,
			createdAt: mailboxes.createdAt,
			hostname: domains.hostname,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
}

export function getMailboxUpdateValues(input: MailboxUpdateValues): MailboxUpdateValues {
	const updates: MailboxUpdateValues = {};

	if ("displayName" in input) {
		updates.displayName = input.displayName?.trim() || null;
	}
	if ("forwardTo" in input) {
		updates.forwardTo = input.forwardTo?.trim() || null;
	}

	return updates;
}
