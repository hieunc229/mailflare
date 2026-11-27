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

// One reply per sender per window. Four days matches the interval Dovecot's
// vacation plugin commonly uses (:days 4).
const autoReplyIntervalMs = 4 * 24 * 60 * 60 * 1000;

export async function sendMailboxAutoReply(
	env: CloudflareEnv,
	input: MailboxAutoReplyInput,
): Promise<void> {
	const recipient = normalizeEmailAddress(input.fromAddress);
	const deliveredAddress = normalizeEmailAddress(input.deliveredAddress);
	if (!recipient.includes("@") || recipient === deliveredAddress || shouldSkipAutoReply(recipient, input.envelopeFrom, input.headers)) return;

	const db = getDb(env);
	const [mailbox] = await db
		.select({
			autoReplyEnabled: mailboxes.autoReplyEnabled,
			autoReplySubject: mailboxes.autoReplySubject,
			autoReplyBody: mailboxes.autoReplyBody,
			autoReplyStartAt: mailboxes.autoReplyStartAt,
			autoReplyEndAt: mailboxes.autoReplyEndAt,
			autoReplyActivatedAt: mailboxes.autoReplyActivatedAt,
			displayName: mailboxes.displayName,
		})
		.from(mailboxes)
		.where(eq(mailboxes.id, input.mailboxId))
		.limit(1);
	if (!mailbox || !isResponderActive(mailbox)) return;

	// The sender may belong to this same account (own mailbox, alias or a
	// shared mailbox); an auto-responder must never reply to it.
	const senderDecision = await resolveInboundAddress(db, recipient);
	if (senderDecision?.mailbox?.userId === input.userId) return;

	// Only deliveries recorded during the current activation and window count:
	// re-enabling the responder or a new scheduled window resets the throttle.
	const floor = Math.max(
		mailbox.autoReplyActivatedAt?.getTime() ?? 0,
		mailbox.autoReplyStartAt?.getTime() ?? 0,
		Date.now() - autoReplyIntervalMs,
	);
	const [recentDelivery] = await db
		.select({ id: autoReplyDeliveries.id })
		.from(autoReplyDeliveries)
		.where(and(
			eq(autoReplyDeliveries.mailboxId, input.mailboxId),
			eq(autoReplyDeliveries.recipient, recipient),
			gte(autoReplyDeliveries.sentAt, new Date(floor)),
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

type AutoReplyWindow = {
	autoReplyEnabled: boolean;
	autoReplyBody: string;
	autoReplyStartAt: Date | null;
	autoReplyEndAt: Date | null;
};

export function isResponderActive(mailbox: AutoReplyWindow, now = new Date()): boolean {
	if (!mailbox.autoReplyEnabled || !mailbox.autoReplyBody.trim()) return false;
	if (mailbox.autoReplyStartAt && now < mailbox.autoReplyStartAt) return false;
	if (mailbox.autoReplyEndAt && now > mailbox.autoReplyEndAt) return false;
	return true;
}

function shouldSkipAutoReply(recipient: string, envelopeFrom: string | null | undefined, headers?: Record<string, string>): boolean {
	// Bounces arrive with an empty envelope sender, a <> Return-Path or both.
	if (envelopeFrom != null && !envelopeFrom.replace(/[<>]/g, "").trim()) return true;
	const returnPath = getHeaderEntry(headers, "return-path");
	if (returnPath && !returnPath[1].replace(/[<>]/g, "").trim()) return true;

	// Normalise away the +tag and separators so noreply@, no-reply@,
	// do_not_reply@ and notifications-noreply@ are all caught.
	const localPart = recipient
		.slice(0, recipient.indexOf("@"))
		.split("+")[0]
		.replace(/[._-]/g, "");
	if (/^(mailerdaemon|postmaster|bounces?)$/.test(localPart)) return true;
	if (/(noreply|donotreply)/.test(localPart)) return true;

	const autoSubmitted = getHeader(headers, "auto-submitted").toLowerCase();
	if (autoSubmitted && autoSubmitted !== "no") return true;
	if (hasListOrBulkPrecedence(headers)) return true;
	return ["x-autoreply", "x-autorespond", "x-auto-response-suppress"]
		.some((name) => !!getHeader(headers, name));
}

function getHeaderEntry(headers: Record<string, string> | undefined, name: string): [string, string] | undefined {
	if (!headers) return undefined;
	return Object.entries(headers).find(([key]) => key.toLowerCase() === name);
}

function getHeader(headers: Record<string, string> | undefined, name: string): string {
	return getHeaderEntry(headers, name)?.[1]?.trim() ?? "";
}
