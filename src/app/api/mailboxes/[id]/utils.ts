import { eq } from "drizzle-orm";
import { domains, mailboxes, users } from "@/db/schema";
import type { getDb } from "@/db";
import type { MailboxUpdateInput, MailboxUpdateValues } from "./types";

type Db = ReturnType<typeof getDb>;

export function selectMailboxById(db: Db, mailboxId: string) {
	return db
		.select({
			id: mailboxes.id,
			userId: mailboxes.userId,
			domainId: mailboxes.domainId,
		localPart: mailboxes.localPart,
		displayName: mailboxes.displayName,
		signature: mailboxes.signature,
		autoReplyEnabled: mailboxes.autoReplyEnabled,
		autoReplySubject: mailboxes.autoReplySubject,
		autoReplyBody: mailboxes.autoReplyBody,
		autoReplyStartAt: mailboxes.autoReplyStartAt,
		autoReplyEndAt: mailboxes.autoReplyEndAt,
		useAllDomains: mailboxes.useAllDomains,
			avatarKey: mailboxes.avatarKey,
			ownerName: users.name,
			ownerEmail: users.email,
			ownerAvatarKey: users.avatarKey,
			type: mailboxes.type,
			disabled: mailboxes.disabled,
			createdAt: mailboxes.createdAt,
			hostname: domains.hostname,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
}

export function getMailboxUpdateValues(input: MailboxUpdateInput, existing?: Pick<MailboxUpdateValues, "autoReplyEnabled">): MailboxUpdateValues {
	const values: MailboxUpdateValues = {};
	if ("displayName" in input) values.displayName = input.displayName?.trim() || null;
	if ("signature" in input) values.signature = input.signature?.trim() || null;
	if ("autoReplyEnabled" in input) {
		values.autoReplyEnabled = input.autoReplyEnabled;
		// The activation stamp is the throttle reset: deliveries older than it
		// no longer suppress a reply, so turning the responder off and back on
		// re-replies to everyone once.
		if (input.autoReplyEnabled && !existing?.autoReplyEnabled) values.autoReplyActivatedAt = new Date();
		if (!input.autoReplyEnabled) values.autoReplyActivatedAt = null;
	}
	if ("autoReplySubject" in input) values.autoReplySubject = input.autoReplySubject?.trim() || "Out of office";
	if ("autoReplyBody" in input) values.autoReplyBody = input.autoReplyBody?.trim() || "";
	if ("autoReplyStartAt" in input) values.autoReplyStartAt = input.autoReplyStartAt ? new Date(input.autoReplyStartAt) : null;
	if ("autoReplyEndAt" in input) values.autoReplyEndAt = input.autoReplyEndAt ? new Date(input.autoReplyEndAt) : null;
	if ("useAllDomains" in input) values.useAllDomains = input.useAllDomains;
	return values;
}
