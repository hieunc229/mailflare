import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveInboundAddress, resolveInboxRuleDestination } from "@/lib/email/routing";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { getMessageContactNames, upsertContactFromAddress } from "@/lib/contacts/service";
import { getEmailAddress } from "@/lib/email/address";
import { sendMailboxAutoReply } from "@/lib/email/auto-reply";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { listMessageAttachments, storeMessageAttachments } from "@/lib/email/attachments";
import { getUnsubscribeUrlFromRawR2Key } from "@/lib/email/unsubscribe";
import { resolveThreadId } from "@/lib/email/threading";
import type { SessionUser } from "@/lib/auth/types";
import { analyzeSpam } from "@/lib/spam/engine";
import { getReputationKeys } from "@/lib/spam/analyzers/reputation";
import { recordReputationObservation } from "@/lib/spam/repository";
import {
	getMailboxNotificationUserIds,
	notifyUsersOfNewMessage,
} from "@/lib/realtime/utils";
import { sendPushNotifications } from "@/lib/push/push-notifications";

export type InboundQueueMessage = {
	from: string;
	to: string;
	rawR2Key: string;
	headers?: Record<string, string>;
};

export async function processInboundMessage(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
): Promise<void> {
	const db = getDb(env);
	// The sender is passed so that sender-based block rules resolve the same way here as they
	// do in the Worker email handler.
	const decision = await resolveInboundAddress(db, payload.to, payload.from);

	if (!decision) {
		console.warn(`No routing for inbound address: ${payload.to}`);
		return;
	}

	if (decision.action === "reject") {
		console.warn(`Rejected inbound: ${payload.to}`);
		return;
	}

	// A forward decision only reaches the queue when the rule keeps a copy; without a
	// destination mailbox there is nothing to store.
	if (decision.action === "forward" && !decision.keepCopy) {
		console.info(`Forward ${payload.to} -> ${decision.forwardTo}`);
		return;
	}

	if (!decision.mailbox) return;
	const [stored] = await db.select({ id: messages.id }).from(messages).where(and(
		eq(messages.mailboxId, decision.mailbox.mailboxId),
		eq(messages.rawR2Key, payload.rawR2Key),
	)).limit(1);
	if (stored) return;

	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) {
		console.error(`Missing R2 object: ${payload.rawR2Key}`);
		return;
	}

	const buffer = await raw.arrayBuffer();
	const parsed = await parseRawMime(buffer);
	const messageId = newId("msg");
	const snippet = buildSnippet(parsed.text, parsed.html);
	const deliveredAddress = getEmailAddress(payload.to) || `${decision.mailbox.localPart}@${decision.mailbox.hostname}`;
	// Keep the whole To header so reply-all can address everyone; rules and
	// webhooks still see the envelope recipient the message was delivered to.
	const toAddr = parsed.toAddr ?? payload.to;
	const fromAddr = parsed.fromAddr ?? payload.from;
	const destination = await resolveInboxRuleDestination(db, {
		mailboxId: decision.mailbox.mailboxId,
		toAddress: payload.to,
		fromAddress: fromAddr,
		subject: parsed.subject,
		content: [parsed.text, parsed.html, snippet].filter(Boolean).join(" "),
	});
	let spamAnalysis: Awaited<ReturnType<typeof analyzeSpam>> | null = null;
	let spamAnalysisError: string | null = null;
	const [owner] = await db.select({ enabled: users.spamProtectionEnabled }).from(users).where(eq(users.id, decision.mailbox.userId)).limit(1);
	if (owner?.enabled !== false) {
		try {
			spamAnalysis = await analyzeSpam(db, {
				mailboxId: decision.mailbox.mailboxId,
				userId: decision.mailbox.userId,
				envelopeFrom: payload.from,
				headers: payload.headers,
				message: parsed,
			});
		} catch (error) {
			spamAnalysisError = error instanceof Error ? error.message.slice(0, 300) : "Spam analysis failed";
			console.error(`Spam analysis failed for ${messageId}`, error);
		}
	}
	if (destination.status === "spam" && spamAnalysis) {
		spamAnalysis = {
			score: 100,
			verdict: "spam",
			signals: [{ id: "mailbox_rule_spam", score: 100, reason: "A mailbox rule marked this message as spam" }],
			fingerprint: spamAnalysis?.fingerprint ?? "",
		};
	}
	const status = destination.status === "received" && spamAnalysis?.verdict === "spam"
		? "spam"
		: destination.status;
	const folderId = status === "spam" ? null : destination.folderId;
	const contact = await upsertContactFromAddress(env, {
		userId: decision.mailbox.userId,
		address: fromAddr,
		source: "inbound",
	});
	const threadId = await resolveThreadId(db, {
		mailboxId: decision.mailbox.mailboxId,
		messageId: parsed.messageId,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
	});

	try {
		await db.insert(messages).values({
			id: messageId,
			userId: decision.mailbox.userId,
			mailboxId: decision.mailbox.mailboxId,
			folderId,
			direction: "inbound",
			providerMessageId: parsed.messageId,
			fromAddr,
			toAddr,
			ccAddr: parsed.ccAddr,
			subject: parsed.subject,
			snippet,
			textBody: parsed.text,
			htmlBody: parsed.html,
			rawR2Key: payload.rawR2Key,
			status,
			threadId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references.length ? parsed.references.join(" ") : null,
			spamScore: spamAnalysis?.score ?? null,
			spamVerdict: spamAnalysis?.verdict ?? null,
			spamSignals: spamAnalysis ? JSON.stringify(spamAnalysis.signals) : null,
			spamAnalyzedAt: spamAnalysis ? new Date() : null,
			spamAnalysisError,
		});

		await storeMessageAttachments(env, messageId, parsed.attachments, { validate: false });
		if (spamAnalysis) {
			try {
				await recordReputationObservation(env, decision.mailbox.mailboxId, getReputationKeys(parsed, spamAnalysis.fingerprint));
			} catch (error) {
				console.error(`Spam reputation observation failed for ${messageId}`, error);
			}
			console.info(JSON.stringify({
				messageId,
				spamScore: spamAnalysis.score,
				verdict: spamAnalysis.verdict,
				signals: spamAnalysis.signals.map((signal) => signal.id),
			}));
		}
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		throw error;
	}

	if (status === "received") {
		try {
			await sendMailboxAutoReply(env, {
				mailboxId: decision.mailbox.mailboxId,
				userId: decision.mailbox.userId,
				deliveredAddress,
				fromAddress: fromAddr,
				incomingMessageId: parsed.messageId,
				headers: payload.headers,
			});
		} catch (error) {
			console.error(`Auto-reply failed for mailbox ${decision.mailbox.mailboxId}`, error);
		}
	}

	if (status !== "spam") {
		const notificationUserIds = await getMailboxNotificationUserIds(
			env,
			decision.mailbox.mailboxId,
			decision.mailbox.userId,
		);
		await notifyUsersOfNewMessage(env, notificationUserIds, {
			type: "new_message",
			messageId,
			mailboxId: decision.mailbox.mailboxId,
			from: fromAddr,
			fromName: contact?.displayName ?? null,
			subject: parsed.subject,
		});

		// Push notifications to mobile devices (non-blocking)
		try {
			await sendPushNotifications(env, notificationUserIds, {
				type: "new_message",
				messageId,
				mailboxId: decision.mailbox.mailboxId,
				from: fromAddr,
				fromName: contact?.displayName ?? null,
				subject: parsed.subject,
			});
		} catch (error) {
			console.error(`Push notification failed for ${messageId}`, error);
		}
	}
	await dispatchWebhooks(env, decision.mailbox.userId, "message.inbound", {
		messageId,
		from: fromAddr,
		to: payload.to,
		cc: parsed.ccAddr ?? undefined,
		subject: parsed.subject,
		threadId,
		spamScore: spamAnalysis?.score,
		spamVerdict: spamAnalysis?.verdict,
	});
}

export async function storeRawToR2(
	env: CloudflareEnv,
	from: string,
	to: string,
	raw: ReadableStream<Uint8Array>,
): Promise<string> {
	const key = `inbound/${Date.now()}-${newId()}.eml`;
	const buffer = await new Response(raw).arrayBuffer();
	await env.BUCKET.put(key, buffer, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from, to },
	});
	return key;
}

export async function getMessageWithBody(env: CloudflareEnv, userId: string, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message || message.userId !== userId) return null;
	const contactNames = await getMessageContactNames(env, userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	return { message: { ...message, ...contactNames }, body: message, attachments, unsubscribeUrl };
}

export async function getMessageWithBodyForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const contactNames = await getMessageContactNames(env, message.userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	return { message: { ...message, ...contactNames }, body: message, attachments, unsubscribeUrl };
}

export async function getMessageMetadataForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const [attachments, unsubscribeUrl] = await Promise.all([
		listMessageAttachments(env, messageId),
		getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key),
	]);
	return { attachments, unsubscribeUrl };
}
