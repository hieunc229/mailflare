import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailGroupMembers, mailGroups } from "@/db/schema";
import { findSuppressed, getSuppressionMode } from "@/lib/deliverability/suppression";
import { isMissingTableError } from "@/lib/database-errors";
import { parseEmailAddressParts } from "@/lib/email/address";
import { normalizeMessageId } from "@/lib/email/threading";
import { singleSenderAddress } from "@/lib/groups/policy-utils";
import { boundParsedEmail } from "@/lib/email/inbound-limits";
import { getOutboundProviderConfig, sendThroughProvider } from "@/lib/email/outbound-provider";
import { MimeLimitError, parseRawMime } from "@/lib/email/parse";
import { groupsAllowed } from "@/lib/groups/license";
import {
	isRateLimited,
	unsubscribeOrigin,
	plain,
	RELAY_DEFER_SECONDS,
	RELAY_MAX_RATE_LIMIT_ATTEMPTS,
	relayFrom,
	relayHeaders,
	relayIdempotencyKey,
	rawHeaderValue,
	relayMessageIdKey,
	relayRetryDelay,
	reserveRelay,
	type GroupRelayMessage,
	type RelayBudget,
} from "@/lib/groups/relay-utils";
import { domainCanSend } from "@/lib/groups/sending";
import { getUnsubscribeSecret } from "@/lib/groups/unsubscribe-secret";
import { signUnsubscribeToken } from "@/lib/groups/unsubscribe-token";

/** The public unsubscribe URL for one member, or null when there is no public origin to link to. */
export async function unsubscribeUrl(env: CloudflareEnv, claim: { groupId: string; memberId: string }): Promise<string | null> {
	const origin = unsubscribeOrigin(env);
	if (!origin) return null;
	return `${origin}/api/groups/unsubscribe/${await signUnsubscribeToken(await getUnsubscribeSecret(env), claim)}`;
}

/**
 * Sends one external member their copy of group mail (spec D-7): the sender's message re-sent from the
 * group address, so it carries our domain's DKIM and passes DMARC even for senders with `p=reject`.
 * Returns "skipped" for anything that can never succeed on retry (the member left, the group paused,
 * the copy swept); a provider failure throws, and the queue retries just this member.
 */
export async function processGroupRelay(env: CloudflareEnv, message: GroupRelayMessage, options: { budget?: RelayBudget } = {}): Promise<"sent" | "skipped"> {
	// Over this batch's subrequest budget: offer the same relay again shortly instead of failing it.
	if (options.budget && !reserveRelay(options.budget)) {
		await env.OUTBOUND_QUEUE.send(message, { delaySeconds: RELAY_DEFER_SECONDS });
		return "skipped";
	}
	const db = getDb(env);
	let found;
	try {
		[found] = await db
			.select({
				group: { id: mailGroups.id, domainId: mailGroups.domainId, localPart: mailGroups.localPart, name: mailGroups.name, replyTo: mailGroups.replyTo, disabled: mailGroups.disabled },
				domain: domains,
				member: mailGroupMembers,
			})
			.from(mailGroupMembers)
			.innerJoin(mailGroups, eq(mailGroupMembers.groupId, mailGroups.id))
			.innerJoin(domains, eq(mailGroups.domainId, domains.id))
			.where(and(eq(mailGroupMembers.id, message.memberId), eq(mailGroupMembers.groupId, message.groupId), eq(mailGroupMembers.kind, "external")))
			.limit(1);
	} catch (error) {
		if (isMissingTableError(error)) return "skipped";
		throw error;
	}
	const email = found?.member.email;
	if (!found || !email || found.group.disabled || !(await groupsAllowed(env)())) return "skipped";
	const { group, domain } = found;
	if (!domainCanSend(domain)) {
		console.warn(`Group ${group.id} cannot relay to ${email}: ${domain.hostname} has no sending set up`);
		return "skipped";
	}
	// Enforce mode skips an address that bounced or complained; record and off modes send (spec D-9).
	if ((await getSuppressionMode(env)) === "enforce" && (await findSuppressed(env, group.domainId, [email])).size) {
		console.warn(`Group ${group.id} skipped suppressed member ${message.memberId}`);
		return "skipped";
	}

	const raw = await env.BUCKET.get(message.rawR2Key);
	if (!raw) {
		// Swept after 7 days, or deleted: a retry cannot bring it back.
		console.error(`Missing relay copy ${message.rawR2Key} for group ${group.id}`);
		return "skipped";
	}
	let parsed;
	const bytes = await raw.arrayBuffer();
	try {
		parsed = boundParsedEmail(await parseRawMime(bytes));
	} catch (error) {
		if (error instanceof MimeLimitError) {
			console.warn(`Group ${group.id} relay not sent: ${error.message}`);
			return "skipped";
		}
		throw error;
	}
	// More than one From address says nothing reliable about who posted (and would put both in our From).
	const senderAddress = singleSenderAddress(rawHeaderValue(bytes, "from") ?? parsed.fromAddr);
	if (!parsed.fromAddr || !senderAddress) {
		console.warn(`Group ${group.id} relay not sent: the message has no single From address`);
		return "skipped";
	}
	const sender = parseEmailAddressParts(parsed.fromAddr);

	const groupAddress = `${group.localPart}@${domain.hostname}`.toLowerCase();
	// Replies to a relayed copy name the original in References, so the poster's client threads them.
	const references = [...new Set([...parsed.references, ...(normalizeMessageId(parsed.messageId) ? [normalizeMessageId(parsed.messageId) as string] : [])])].slice(-20);
	const headers = relayHeaders({
		groupId: group.id,
		groupName: group.name,
		localPart: group.localPart,
		hostname: domain.hostname,
		replyTo: group.replyTo,
		senderAddress,
		originalFrom: parsed.fromAddr,
		unsubscribeUrl: await unsubscribeUrl(env, { groupId: group.id, memberId: found.member.id }),
		inReplyTo: parsed.inReplyTo ? `<${parsed.inReplyTo}>` : null,
		references: references.map((id) => `<${id}>`),
	});
	const from = relayFrom({ senderName: sender.name ?? "", senderAddress, groupName: group.name, groupAddress });
	let sent: { messageId: string };
	try {
		sent = await sendThroughProvider(
			env,
			await getOutboundProviderConfig(env, groupAddress),
			{
				from,
				to: [email],
				subject: plain(parsed.subject ?? ""),
				text: parsed.text ?? undefined,
				html: parsed.html ?? undefined,
				headers,
				attachments: parsed.attachments.map((attachment) => ({
					filename: attachment.filename,
					type: attachment.type,
					content: attachment.content,
					disposition: attachment.disposition === "inline" ? "inline" : "attachment",
					contentId: attachment.contentId ?? null,
				})),
			},
			relayIdempotencyKey(message),
		);
	} catch (error) {
		const attempt = message.attempt ?? 0;
		// A rate limit is the provider asking for time, not a failure: wait it out without spending a queue retry.
		if (isRateLimited(error) && attempt < RELAY_MAX_RATE_LIMIT_ATTEMPTS) {
			await env.OUTBOUND_QUEUE.send({ ...message, attempt: attempt + 1 }, { delaySeconds: relayRetryDelay(attempt) });
			console.warn(`Group ${group.id} relay to ${message.memberId} rate limited; retrying in ${relayRetryDelay(attempt)}s`);
			return "skipped";
		}
		throw error;
	}
	// Remember which member this provider Message-ID belongs to, so a bounce or auto-reply that names it can be traced.
	await env.BUCKET.put(await relayMessageIdKey(sent.messageId), new TextEncoder().encode(JSON.stringify({ g: group.id, m: found.member.id })), { httpMetadata: { contentType: "application/json" } })
		.catch((error: unknown) => console.error("Recording a relayed Message-ID failed", error));
	return "sent";
}
