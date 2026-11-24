import { and, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { autoReplyDeliveries, mailboxes } from "@/db/schema";
import { formatEmailAddress, normalizeEmailAddress } from "@/lib/email/address";
import { resolveInboundAddress } from "@/lib/email/routing";
import { sendEmail } from "@/lib/email/send";
import { SuppressedRecipientError } from "@/lib/deliverability/suppression-utils";
import { newId } from "@/lib/ids";
import type { MailboxAutoReplyInput } from "./auto-reply-types";
import { hasListOrBulkPrecedence } from "@/lib/email/bulk-mail";

const autoReplyIntervalMs = 24 * 60 * 60 * 1000;

export async function sendMailboxAutoReply(
	env: CloudflareEnv,
	input: MailboxAutoReplyInput,
): Promise<void> {
	const recipient = normalizeEmailAddress(input.fromAddress);
	const deliveredAddress = normalizeEmailAddress(input.deliveredAddress);
	if (!recipient.includes("@") || recipient === deliveredAddress || shouldSkipAutoReply(recipient, input.headers)) return;

	const db = getDb(env);
	const senderDecision = await resolveInboundAddress(db, recipient);
	if (senderDecision?.mailbox?.mailboxId === input.mailboxId) return;
	const [mailbox] = await db
		.select({
			autoReplyEnabled: mailboxes.autoReplyEnabled,
			autoReplySubject: mailboxes.autoReplySubject,
			autoReplyBody: mailboxes.autoReplyBody,
			displayName: mailboxes.displayName,
		})
		.from(mailboxes)
		.where(eq(mailboxes.id, input.mailboxId))
		.limit(1);
	if (!mailbox?.autoReplyEnabled || !mailbox.autoReplyBody.trim()) return;

	const [recentDelivery] = await db
		.select({ id: autoReplyDeliveries.id })
		.from(autoReplyDeliveries)
		.where(and(
			eq(autoReplyDeliveries.mailboxId, input.mailboxId),
			eq(autoReplyDeliveries.recipient, recipient),
			gte(autoReplyDeliveries.sentAt, new Date(Date.now() - autoReplyIntervalMs)),
		))
		.limit(1);
	if (recentDelivery) return;

	const headers: Record<string, string> = {
		"Auto-Submitted": "auto-replied",
		"X-Auto-Response-Suppress": "All",
	};
	if (input.incomingMessageId) {
		headers["In-Reply-To"] = input.incomingMessageId;
		headers.References = input.incomingMessageId;
	}

	try {
		await sendEmail(env, {
			userId: input.userId,
			mailboxId: input.mailboxId,
			from: formatEmailAddress(deliveredAddress, mailbox.displayName),
			to: recipient,
			subject: mailbox.autoReplySubject.trim() || "Out of office",
			text: mailbox.autoReplyBody.trim(),
			headers,
		});
	} catch (error) {
		// The sender bounced or complained before: an out-of-office reply is not worth another bounce.
		if (error instanceof SuppressedRecipientError) return;
		throw error;
	}

	await db
		.insert(autoReplyDeliveries)
		.values({
			id: newId("arp"),
			mailboxId: input.mailboxId,
			recipient,
			sentAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [autoReplyDeliveries.mailboxId, autoReplyDeliveries.recipient],
			set: { sentAt: new Date() },
		});
}

function shouldSkipAutoReply(recipient: string, headers?: Record<string, string>): boolean {
	const localPart = recipient.slice(0, recipient.indexOf("@"));
	if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)$/i.test(localPart)) return true;

	const autoSubmitted = getHeader(headers, "auto-submitted").toLowerCase();
	if (autoSubmitted && autoSubmitted !== "no") return true;
	if (hasListOrBulkPrecedence(headers)) return true;
	return ["x-autoreply", "x-autorespond", "x-auto-response-suppress"]
		.some((name) => !!getHeader(headers, name));
}

function getHeader(headers: Record<string, string> | undefined, name: string): string {
	if (!headers) return "";
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
	return entry?.[1]?.trim() ?? "";
}
