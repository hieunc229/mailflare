import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { conversationNotes, messages, outboundJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { upsertContactsFromAddresses } from "@/lib/contacts/service";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { getEmailAddressList, joinEmailAddressList, splitEmailAddressList } from "@/lib/email/address";
import { formatMessageIdHeader, normalizeMessageId, parseMessageIdList } from "@/lib/email/threading";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { loadMessageAttachmentContents, storeMessageAttachments, validateAttachments } from "@/lib/email/attachments";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { getOutboundAttachmentMaxMb } from "@/lib/email/attachment-policy";
import { getOutboundProviderConfig, sendThroughProvider } from "@/lib/email/outbound-provider";
import { prepareCloudflareAttachments } from "@/lib/email/cloud-attachment-utils";
import { ensureTrackingToken, getTrackingHostForSender } from "@/lib/tracking/open-tracking";
import { setFollowUp } from "@/lib/follow-ups/service";
import { buildTrackingPixelUrl, injectTrackingPixel, resolveTrackingOrigin } from "@/lib/tracking/open-tracking-utils";
import { getComposePreferences } from "@/lib/compose/preferences";

export type SendEmailInput = {
	userId: string;
	from: string;
	/** One header-style list or an array; each entry may carry a display name. */
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	/** Message-ID of the message being replied to, with or without angle brackets. */
	inReplyTo?: string | null;
	/** References chain, as a header string or a list of Message-IDs. */
	references?: string | string[] | null;
	/** Conversation to file the sent copy under; defaults to its own Message-ID. */
	threadId?: string | null;
	mailboxId: string;
	attachments?: AttachmentContent[];
	/** Future delivery time. Values at or before the current time send immediately. */
	scheduledAt?: string | Date;
	/** Hold the send for the user's undo window (via the scheduled queue) so they can cancel it. */
	undoSend?: boolean;
	/** Add a read-receipt pixel to the HTML part (the stored Sent copy stays without it). */
	trackOpens?: boolean;
	/** Bring the thread back to the inbox after this many days unless a reply arrives. */
	followUpDays?: number;
	publicOrigin?: string;
};

/** How long a send started from the composer waits before it is delivered. */
const MAX_RECIPIENTS = 50;
const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

type PreparedDelivery = {
	input: SendEmailInput;
	messageId: string;
	jobId: string;
	from: string;
	mailboxId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	headers: Record<string, string>;
	attachments: AttachmentContent[];
};

function toRecipientList(value: string | string[] | undefined): string[] {
	const entries = Array.isArray(value) ? value : splitEmailAddressList(value);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of entries) {
		const [address] = getEmailAddressList(entry);
		if (!address || seen.has(address)) continue;
		seen.add(address);
		result.push(entry.trim());
	}
	return result;
}

export async function sendEmail(
	env: CloudflareEnv,
	input: SendEmailInput,
): Promise<{ messageId: string; scheduled?: boolean; undoSeconds?: number; undoRemainingMs?: number; scheduledAt?: string }> {
	const db = getDb(env);
	const sender = await getAuthorizedSenderAddress(env, input);
	const attachments = input.attachments ?? [];
	validateAttachments(attachments);
	const maxAttachmentMb = await getOutboundAttachmentMaxMb(env);
	const maxAttachmentBytes = maxAttachmentMb * 1_000_000;
	if (attachments.some((attachment) => attachment.content.byteLength > maxAttachmentBytes) ||
		attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0) > maxAttachmentBytes) {
		throw new Error(`Attachments exceed the administrator's ${maxAttachmentMb} MB outgoing limit`);
	}
	if (input.subject.length > 998) throw new Error("Subject exceeds Cloudflare's 998-character limit");

	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	if (to.length === 0) throw new Error("At least one recipient is required");
	if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
		throw new Error(`A message can have at most ${MAX_RECIPIENTS} recipients`);
	}
	await upsertContactsFromAddresses(env, input.userId, [...to, ...cc, ...bcc], "outbound");

	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	if (new TextEncoder().encode(Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")).byteLength > 16 * 1024) {
		throw new Error("Headers exceed Cloudflare's 16 KB limit");
	}

	const messageId = newId("msg");
	const requestedSchedule = input.scheduledAt ? new Date(input.scheduledAt) : null;
	const userScheduledAt = requestedSchedule && requestedSchedule.getTime() > Date.now()
		? requestedSchedule
		: null;
	// An explicit schedule wins; otherwise an undoable send waits out the user's undo window.
	const undoSeconds = !userScheduledAt && input.undoSend ? (await getComposePreferences(env, input.userId)).undoSendSeconds : 0;
	const scheduledAt = userScheduledAt ?? (undoSeconds > 0 ? new Date(Date.now() + undoSeconds * 1000) : null);
	const snippet = buildSnippet(input.text ?? null, input.html ?? null);
	const toAddr = joinEmailAddressList(to);

	await db.insert(messages).values({
		id: messageId,
		userId: input.userId,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr,
		ccAddr: cc.length ? joinEmailAddressList(cc) : null,
		bccAddr: bcc.length ? joinEmailAddressList(bcc) : null,
		subject: input.subject,
		snippet,
		textBody: input.text ?? null,
		htmlBody: input.html ?? null,
		status: "queued",
		read: true,
		threadId: input.threadId ?? null,
		inReplyTo,
		references: references.length ? references.join(" ") : null,
	});
	try {
		const stored = await storeMessageAttachments(env, messageId, attachments);
		stored.forEach((attachment, index) => { attachments[index].storageId = attachment.id; });
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		throw error;
	}

	const jobId = newId("job");
	await db.insert(outboundJobs).values({
		id: jobId,
		userId: input.userId,
		messageId,
		status: "queued",
		payload: JSON.stringify({
			...input,
			from: sender.fromAddr,
			to,
			cc,
			bcc,
			mailboxId: sender.mailboxId,
			attachments: attachments.map(({ content: _content, ...attachment }) => attachment),
		}),
		scheduledAt,
	});

	const delivery: PreparedDelivery = {
		input: { ...input, attachments: undefined },
		messageId,
		jobId,
		from: sender.fromAddr,
		mailboxId: sender.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments,
	};
	if (scheduledAt) {
		await enqueueScheduledDelivery(env, delivery, scheduledAt);
		if (userScheduledAt) {
			return { messageId, scheduled: true, scheduledAt: scheduledAt.toISOString() };
		}
		// Send the window as a duration: client and server clocks need not agree.
		return {
			messageId,
			scheduled: true,
			undoSeconds,
			undoRemainingMs: Math.max(0, scheduledAt.getTime() - Date.now()),
		};
	}

	await deliverEmail(env, delivery);
	return { messageId };
}

export function isPermanentDeliveryError(error: unknown): boolean {
	if (!error) return false;
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	const status = typeof (error as { status?: unknown }).status === "number"
		? (error as { status: number }).status
		: undefined;

	// Explicit HTTP response status checks
	if (status !== undefined) {
		// 429 Too Many Requests or 5xx Server Errors are transient and retryable
		if (status === 429 || status >= 500) return false;
		// 4xx Client Errors (except 429) indicate permanent misconfiguration or invalid input
		if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) return true;
	}

	// Message content checks for known transient issues
	if (
		message.includes("rate limit") ||
		message.includes("too many requests") ||
		message.includes("429") ||
		message.includes("timeout") ||
		message.includes("timed out") ||
		message.includes("econnreset") ||
		message.includes("econnrefused") ||
		message.includes("fetch failed") ||
		message.includes("500 internal") ||
		message.includes("502 bad gateway") ||
		message.includes("503") ||
		message.includes("504") ||
		message.includes("network error") ||
		message.includes("temporarily unavailable")
	) {
		return false;
	}

	// Message content checks for known permanent issues
	if (
		message.includes("invalid email") ||
		message.includes("invalid recipient") ||
		message.includes("not verified") ||
		message.includes("unauthorized") ||
		message.includes("forbidden") ||
		message.includes("exceeds limit") ||
		message.includes("blacklisted") ||
		message.includes("does not exist") ||
		message.includes("rejected by provider")
	) {
		return true;
	}

	return false;
}

export type DeliveryRetryOptions = {
	attempt?: number;
	maxAttempts?: number;
};

async function deliverEmail(env: CloudflareEnv, delivery: PreparedDelivery, options?: DeliveryRetryOptions): Promise<void> {
	const { input, messageId, jobId, from, mailboxId, to, cc, bcc, headers, attachments } = delivery;
	const db = getDb(env);
	const toAddr = joinEmailAddressList(to);
	const attempt = options?.attempt ?? 1;
	const maxAttempts = options?.maxAttempts ?? 3;

	try {
		const provider = await getOutboundProviderConfig(env, from);
		// Cloudflare's 5 MiB cap forces big files into download links; Resend takes
		// the attachments directly (the admin's outgoing limit still applies).
		const prepared = provider.provider === "cloudflare"
			? await prepareCloudflareAttachments(env, attachments, {
				subject: input.subject,
				html: input.html,
				text: input.text,
				headers,
				publicOrigin: input.publicOrigin,
			})
			: { attachments, html: input.html, text: input.text };
		if (prepared.text !== input.text || prepared.html !== input.html) {
			await db.update(messages).set({ textBody: prepared.text ?? null, htmlBody: prepared.html ?? null }).where(eq(messages.id, messageId));
		}
		const html = input.trackOpens && prepared.html ? await withTrackingPixel(env, messageId, from, prepared.html, input.publicOrigin) : prepared.html;
		const response = await sendThroughProvider(
			env,
			provider,
			{
				from,
				to,
				cc,
				bcc,
				subject: input.subject,
				headers,
				html,
				text: prepared.text,
				attachments: prepared.attachments.map((attachment) => ({
					filename: attachment.filename,
					type: attachment.type,
					content: attachment.content,
					disposition: attachment.disposition === "inline" && attachment.contentId ? "inline" : "attachment",
					contentId: attachment.contentId,
				})),
			},
			jobId,
		);

		// A fresh message starts its own conversation; Cloudflare's Message-ID is what
		// any reply will name in In-Reply-To, so key the thread by it.
		const threadId = input.threadId ?? normalizeMessageId(response.messageId) ?? messageId;
		await db
			.update(messages)
			.set({
				status: "sent",
				providerMessageId: response.messageId,
				threadId,
			})
			.where(eq(messages.id, messageId));
		// Notes taken while the message waited in the queue keyed its conversation by
		// the message id; move them onto the thread key the send just established.
		if (threadId !== messageId) {
			await db
				.update(conversationNotes)
				.set({ threadKey: threadId })
				.where(and(eq(conversationNotes.mailboxId, mailboxId), eq(conversationNotes.threadKey, messageId)));
		}
		await db.update(outboundJobs).set({ status: "sent", error: null, updatedAt: new Date() }).where(eq(outboundJobs.id, jobId));
		if (input.followUpDays) {
			// The message is already out; a reminder that cannot be stored must not fail the send.
			await setFollowUp(env, { messageId, userId: input.userId, days: input.followUpDays }).catch((error) => console.error("Follow-up reminder skipped", error));
		}

		await dispatchWebhooks(env, input.userId, "message.outbound", {
			messageId,
			providerMessageId: response.messageId,
			to: toAddr,
			cc: cc.length ? joinEmailAddressList(cc) : undefined,
		});
		await createAuditLog(env, {
			actorUserId: input.userId,
			mailboxId,
			messageId,
			action: "email.send",
			metadata: { to: toAddr, cc: cc.length ? joinEmailAddressList(cc) : undefined, subject: input.subject },
		});
	} catch (err) {
		const error = err instanceof Error ? err.message : "Send failed";
		const isPermanent = isPermanentDeliveryError(err);
		const isExhausted = attempt >= maxAttempts;

		if (isPermanent || isExhausted) {
			// Permanent failure or max attempts exhausted: mark failed and dispatch webhook
			await db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId));
			await db
				.update(outboundJobs)
				.set({
					status: "failed",
					error: isPermanent ? `[Permanent error] ${error}` : `[Exhausted after ${attempt} attempt(s)] ${error}`,
					updatedAt: new Date(),
				})
				.where(eq(outboundJobs.id, jobId));
			await dispatchWebhooks(env, input.userId, "message.failed", { messageId, error });
		} else {
			// Transient failure: release claim and reset status to 'queued' so Queue retry can proceed
			await db
				.update(outboundJobs)
				.set({
					status: "queued",
					error: `[Attempt ${attempt}/${maxAttempts} failed, retrying] ${error}`,
					updatedAt: new Date(),
				})
				.where(eq(outboundJobs.id, jobId));
			await db.update(messages).set({ status: "queued" }).where(eq(messages.id, messageId));
		}
		throw err;
	}
}

/**
 * The sender domain's own pixel host wins over APP_URL so the pixel matches the From domain.
 * A missing origin or an unapplied migration sends the message untracked rather than failing it.
 */
async function withTrackingPixel(env: CloudflareEnv, messageId: string, from: string, html: string, publicOrigin: string | undefined): Promise<string> {
	try {
		const host = await getTrackingHostForSender(env, from);
		const origin = host ? `https://${host}` : resolveTrackingOrigin(env.APP_URL, publicOrigin);
		if (!origin) return html;
		const token = await ensureTrackingToken(env, messageId);
		return injectTrackingPixel(html, buildTrackingPixelUrl(origin, token));
	} catch (error) {
		console.error("Read receipt skipped", error);
		return html;
	}
}

export type OutboundQueueMessage = {
	kind: "email.scheduled";
	jobId: string;
	messageId: string;
	scheduledAt: string;
	attempt?: number;
};

/** Wakes the outbound queue when a job is due; runs again at the delay cap for later times. */
export async function enqueueOutboundJob(
	env: CloudflareEnv,
	jobId: string,
	messageId: string,
	scheduledAt: Date,
): Promise<void> {
	const delaySeconds = Math.min(
		MAX_QUEUE_DELAY_SECONDS,
		Math.max(1, Math.ceil((scheduledAt.getTime() - Date.now()) / 1000)),
	);
	await env.OUTBOUND_QUEUE.send(
		{
			kind: "email.scheduled",
			jobId,
			messageId,
			scheduledAt: scheduledAt.toISOString(),
		},
		{ delaySeconds },
	);
}

async function enqueueScheduledDelivery(
	env: CloudflareEnv,
	delivery: PreparedDelivery,
	scheduledAt: Date,
): Promise<void> {
	await enqueueOutboundJob(env, delivery.jobId, delivery.messageId, scheduledAt);
}

function deliveryFromJob(jobId: string, messageId: string, payload: string): PreparedDelivery {
	const input = JSON.parse(payload) as SendEmailInput;
	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	return {
		input,
		messageId,
		jobId,
		from: input.from,
		mailboxId: input.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments: [],
	};
}

/** With `dueAt`, the claim also requires the job to still hold that send time, so a
 * reschedule that lands after the due check cannot be overtaken by the old time. */
function claimJob(db: ReturnType<typeof getDb>, jobId: string, dueAt?: Date | null) {
	return db
		.update(outboundJobs)
		.set({ status: "sending", updatedAt: new Date() })
		.where(and(
			eq(outboundJobs.id, jobId),
			eq(outboundJobs.status, "queued"),
			...(dueAt ? [eq(outboundJobs.scheduledAt, dueAt)] : []),
		))
		.returning({ id: outboundJobs.id });
}

/**
 * Sends a scheduled message before its due time. The job is claimed the same way
 * the queue consumer claims it, so send-now and the queued delivery cannot both send.
 * Returns false when the message has already left the queue.
 */
export async function sendScheduledMessageNow(env: CloudflareEnv, messageId: string): Promise<boolean> {
	const db = getDb(env);
	const [job] = await db
		.select({ id: outboundJobs.id, payload: outboundJobs.payload })
		.from(outboundJobs)
		.where(and(eq(outboundJobs.messageId, messageId), eq(outboundJobs.status, "queued"), isNotNull(outboundJobs.scheduledAt)))
		.limit(1);
	if (!job) return false;
	const delivery = deliveryFromJob(job.id, messageId, job.payload);
	// Load first: a failure here must leave the job queued so the scheduled send can retry.
	delivery.attachments = await loadMessageAttachmentContents(env, messageId);
	const claimed = await claimJob(db, job.id);
	if (!claimed.length) return false;
	await deliverEmail(env, delivery);
	return true;
}

export async function processOutboundQueue(
	env: CloudflareEnv,
	payload: OutboundQueueMessage,
	attempt: number = payload.attempt ?? 1,
): Promise<void> {
	const db = getDb(env);
	const [job] = await db
		.select({ status: outboundJobs.status, payload: outboundJobs.payload, scheduledAt: outboundJobs.scheduledAt })
		.from(outboundJobs)
		.where(eq(outboundJobs.id, payload.jobId))
		.limit(1);
	if (!job || job.status !== "queued") return;
	// The job row is authoritative: rescheduling edits it while queued messages
	// already in flight still carry the old time.
	const scheduledAt = job.scheduledAt ?? new Date(payload.scheduledAt);
	const delivery = deliveryFromJob(payload.jobId, payload.messageId, job.payload);
	if (scheduledAt.getTime() > Date.now()) {
		await enqueueScheduledDelivery(env, delivery, scheduledAt);
		return;
	}
	// Claim the job before delivering. Cancelling deletes only a job that is still
	// "queued", so exactly one of cancel and delivery wins.
	const claimed = await claimJob(db, payload.jobId, job.scheduledAt);
	if (!claimed.length) {
		// Lost to a cancel or another consumer, or the send time moved after we
		// read it. In the last case the job is still queued: look again.
		const [current] = await db.select({ status: outboundJobs.status }).from(outboundJobs).where(eq(outboundJobs.id, payload.jobId)).limit(1);
		if (current?.status === "queued") await processOutboundQueue(env, payload, attempt);
		return;
	}
	delivery.attachments = await loadMessageAttachmentContents(env, payload.messageId);
	try {
		await deliverEmail(env, delivery, { attempt, maxAttempts: 3 });
	} catch (err) {
		// When the error is permanent or retries are exhausted, deliverEmail has already
		// updated the database (messages and outbound_jobs set to 'failed') and dispatched
		// the failure webhook. Suppress re-throw so the queue consumer acknowledges
		// the message immediately instead of scheduling a redundant retry.
		if (isPermanentDeliveryError(err) || attempt >= 3) {
			return;
		}
		// For transient errors with attempts remaining, re-throw so worker.ts calls msg.retry({ delaySeconds: 10 })
		throw err;
	}
}
