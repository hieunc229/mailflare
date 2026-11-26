import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailGroupMembers, mailGroups } from "@/db/schema";
import { findSuppressed, getSuppressionMode } from "@/lib/deliverability/suppression";
import { isMissingTableError } from "@/lib/database-errors";
import { forwardedMarker, markerSecret } from "@/lib/email/account-forwarding";
import { parseEmailAddressParts } from "@/lib/email/address";
import { boundParsedEmail } from "@/lib/email/inbound-limits";
import { getOutboundProviderConfig, sendThroughProvider } from "@/lib/email/outbound-provider";
import { MimeLimitError, parseRawMime } from "@/lib/email/parse";
import { groupsAllowed } from "@/lib/groups/license";
import {
	RELAY_DEFER_SECONDS,
	relayFrom,
	relayHeaders,
	relayIdempotencyKey,
	reserveRelay,
	type GroupRelayMessage,
	type RelayBudget,
} from "@/lib/groups/relay-utils";
import { domainCanSend } from "@/lib/groups/sending";
import { signUnsubscribeToken } from "@/lib/groups/unsubscribe-token";

/** The public unsubscribe URL for one member, or null when there is no server secret or no public origin to sign and link with. */
export async function unsubscribeUrl(env: CloudflareEnv, claim: { groupId: string; memberId: string; email: string }): Promise<string | null> {
	const secret = markerSecret(env);
	const origin = env.APP_URL?.trim().replace(/\/+$/, "");
	if (!secret || !origin || !/^https:\/\//i.test(origin)) return null;
	return `${origin}/api/groups/unsubscribe/${await signUnsubscribeToken(secret, claim)}`;
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
			.select({ group: mailGroups, domain: domains, member: mailGroupMembers })
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
	try {
		parsed = boundParsedEmail(await parseRawMime(await raw.arrayBuffer()));
	} catch (error) {
		if (error instanceof MimeLimitError) {
			console.warn(`Group ${group.id} relay not sent: ${error.message}`);
			return "skipped";
		}
		throw error;
	}
	const sender = parsed.fromAddr ? parseEmailAddressParts(parsed.fromAddr) : null;
	if (!sender?.address) {
		console.warn(`Group ${group.id} relay not sent: the message has no From address`);
		return "skipped";
	}

	const groupAddress = `${group.localPart}@${domain.hostname}`.toLowerCase();
	const headers = relayHeaders({
		groupId: group.id,
		groupName: group.name,
		localPart: group.localPart,
		hostname: domain.hostname,
		replyTo: group.replyTo,
		senderAddress: sender.address,
		marker: await forwardedMarker(env),
		unsubscribeUrl: await unsubscribeUrl(env, { groupId: group.id, memberId: found.member.id, email }),
		inReplyTo: parsed.inReplyTo ? `<${parsed.inReplyTo}>` : null,
		references: parsed.references.map((id) => `<${id}>`),
	});
	const from = relayFrom({ senderName: sender.name ?? "", senderAddress: sender.address, groupName: group.name, groupAddress });
	await sendThroughProvider(
		env,
		await getOutboundProviderConfig(env, groupAddress),
		{
			from,
			to: [email],
			subject: parsed.subject ?? "",
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
	return "sent";
}
