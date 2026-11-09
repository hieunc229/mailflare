import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import { getMailboxAliasForAddress, getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { resolveMailboxDisplayName } from "@/lib/profile/identity-utils";

export async function getAuthorizedSenderAddress(
	env: CloudflareEnv,
	input: {
		userId: string;
		from: string;
		mailboxId?: string | null;
	},
): Promise<{ fromAddr: string; mailboxId: string }> {
	if (!input.mailboxId) throw new Error("Mailbox is required");

	const db = getDb(env);
	const [mailbox] = await db
		.select({
		localPart: mailboxes.localPart,
		displayName: mailboxes.displayName,
		type: mailboxes.type,
		ownerName: users.name,
		ownerEmail: users.email,
		hostname: domains.hostname,
		domainId: mailboxes.domainId,
		useAllDomains: mailboxes.useAllDomains,
			id: mailboxes.id,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(eq(mailboxes.id, input.mailboxId))
		.limit(1);

	if (!mailbox) throw new Error("Mailbox not found");
	const [actor] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
	if (!actor || actor.disabled) throw new Error("Sender account not found");

	const access = await getMailboxAccessLevel(db, actor, mailbox.id);
	if (!access?.canSendOnBehalf) {
		throw new Error("You do not have permission to send from this mailbox");
	}

	const requestedAddress = getEmailAddress(input.from);
	const permittedAddresses = await getMailboxDomainAddresses(db, mailbox);
	if (!permittedAddresses.includes(requestedAddress.toLowerCase())) {
		throw new Error("Sender address does not match the selected mailbox");
	}
	const senderAddress = requestedAddress.toLowerCase();
	// The primary mailbox sends under the account name; every other mailbox
	// sends under its own. A masked alias hides both and sends under its own
	// label, or the bare address when it has none.
	const alias = await getMailboxAliasForAddress(db, mailbox.id, senderAddress);
	const senderName = alias?.masked
		? alias.label?.trim() || null
		: resolveMailboxDisplayName(mailbox, mailbox.ownerEmail, mailbox.ownerName);

	if (access.canSendAs) {
		return {
			fromAddr: formatEmailAddress(senderAddress, senderName),
			mailboxId: mailbox.id,
		};
	}

	// On-behalf sends keep the acting delegate's name for accountability, while
	// the mailbox side still resolves to the alias label or bare address — a
	// masked alias never exposes the mailbox owner's name either way.
	const mailboxName = senderName || senderAddress;
	return {
		fromAddr: formatEmailAddress(senderAddress, `${actor.name} on behalf of ${mailboxName}`),
		mailboxId: mailbox.id,
	};
}
