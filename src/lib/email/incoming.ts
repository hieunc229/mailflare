import { getDb } from "@/db";
import { recordRuleMatch, resolveInboundAddress, type RoutingDecision } from "@/lib/email/routing";
import { matchReportAddress } from "@/lib/deliverability/report-address";
import { forwardedMarker, MAILFLARE_FORWARDED_HEADER } from "@/lib/email/account-forwarding";
import { getEmailAddress, splitEmailAddressList } from "@/lib/email/address";
import { groupListIdentifier, groupDropReason, isAutomatedMail } from "@/lib/groups/loop-utils";
import { groupsAllowed } from "@/lib/groups/license";
import { answersRelayedCopy, recordRelayBounce } from "@/lib/groups/relay-bounces";
import { findMemberSenderAddress, isExternalMember, loadOrgHostnames } from "@/lib/groups/policy";
import { canPost, GROUP_POST_REJECT_REASON } from "@/lib/groups/policy-utils";
import { readTrustedDmarcResult } from "@/lib/spam/analyzers/authentication";
import type { ProviderVerdicts } from "@/lib/spam/types";

/**
 * A routing decision, `report` (DMARC report mail, which only the report queue consumer may touch),
 * or `drop`: group mail that must vanish silently so it cannot loop.
 */
export type IncomingDecision = RoutingDecision | { action: "report" } | { action: "drop" };

/**
 * Resolves the routing decision for a live inbound message. Used by the Worker `email`
 * handler, where `forward()` and `setReject()` are still available on the message.
 *
 * A routing failure must not stop mail from being stored, so resolving never throws. Checking who
 * may post to a group does: failing open there would let anyone post to a restricted group.
 */
export async function resolveIncomingMail(
	env: CloudflareEnv,
	from: string,
	to: string,
	headers?: {
		subject?: string | null;
		from?: string | null;
		alreadyForwarded?: boolean;
		all?: Record<string, string>;
		/** Verdicts the receiving provider or SMTP listener computed; they decide who may post to a group. */
		verdicts?: ProviderVerdicts;
		/** How many `Received` headers the message carries, for the group loop guard. */
		receivedHops?: number;
		/** Reads the raw message; only called for a bounce to a group, to trace it to the relayed copy it names. */
		loadRaw?: () => Promise<ArrayBuffer>;
	},
): Promise<IncomingDecision | null> {
	let decision: RoutingDecision | null;
	try {
		const db = getDb(env);
		// A DMARC report address is never a mailbox: no reject or forward rule (a catch-all included), and no account
		// forwarding, may apply to it. Callers store it and queue it for the report consumer, nothing else.
		if (await matchReportAddress(env, to)) return { action: "report" };
		decision = await resolveInboundAddress(db, to, from, {
			headers: headers?.all,
			allowGroups: groupsAllowed(env),
			// A message that already went through a forward is never forwarded again by a
			// mailbox rule, so two inboxes forwarding to each other cannot loop.
			mailboxForwards: headers?.alreadyForwarded ? undefined : { subject: headers?.subject, from: headers?.from },
		});
		if (decision?.ruleId) {
			await recordRuleMatch(db, decision.ruleId).catch(() => undefined);
		}
	} catch (error) {
		console.error(`Routing resolution failed for ${to}`, error);
		return null;
	}
	// Outside the try: a failure while checking who may post must not let the message through. It
	// throws, the handler fails the delivery, and the sender retries.
	return decision?.action === "group" ? admitGroupMail(env, decision, { ...headers, envelopeFrom: from }) : decision;
}

/** Group mail is dropped (loops), rejected (not allowed to post) or admitted unchanged. */
export async function admitGroupMail(
	env: CloudflareEnv,
	decision: RoutingDecision,
	input: { all?: Record<string, string>; verdicts?: ProviderVerdicts; receivedHops?: number; from?: string | null; envelopeFrom?: string; loadRaw?: () => Promise<ArrayBuffer> } = {},
): Promise<IncomingDecision> {
	const group = decision.group;
	if (!group) return decision;
	const headers = input.all ?? {};
	const hostname = group.address.slice(group.address.lastIndexOf("@") + 1);
	const dropReason = groupDropReason({
		groupId: group.groupId,
		listIdentifier: groupListIdentifier(group.address.slice(0, group.address.lastIndexOf("@")), hostname),
		headers,
		receivedHops: input.receivedHops ?? 0,
		envelopeFrom: input.envelopeFrom,
	});
	if (dropReason) {
		// A bounce of a relayed copy is how a bad external address is learned: trace it before it is discarded.
		if (input.loadRaw && ["null sender", "null return path", "delivery report"].includes(dropReason)) {
			try {
				await recordRelayBounce(env, group, await input.loadRaw());
			} catch (error) {
				console.error(`Tracing a bounce to group ${group.address} failed`, error);
			}
		}
		console.warn(`Dropped mail to group ${group.address}: ${dropReason}`);
		return { action: "drop" };
	}
	const db = getDb(env);
	// An external member's auto-ack to a relayed copy is `auto-generated`, which the guard above lets through for
	// alerts and invoices. Without a marker on it, only the sender tells it apart: drop automated mail from a member.
	if (isAutomatedMail(headers)) {
		const senders = [input.envelopeFrom, ...splitEmailAddressList(input.from ?? headers.from).map((entry) => getEmailAddress(entry))].filter((value): value is string => !!value);
		if (await isExternalMember(db, group.groupId, senders)) {
			console.warn(`Dropped mail to group ${group.address}: automated mail from an external member`);
			return { action: "drop" };
		}
		// An auto-ack from some other address (a ticket system's) still names the relayed copy it answers.
		if (await answersRelayedCopy(env, group.groupId, headers)) {
			console.warn(`Dropped mail to group ${group.address}: automated answer to a relayed copy`);
			return { action: "drop" };
		}
	}
	if (group.whoCanPost === "anyone") return decision;
	const senderAddress = input.from ?? headers.from ?? "";
	const allowed = canPost({
		whoCanPost: group.whoCanPost,
		senderAddress,
		dmarc: readTrustedDmarcResult(headers, input.verdicts),
		orgHostnames: group.whoCanPost === "org" ? await loadOrgHostnames(db) : [],
		memberAddresses: group.whoCanPost === "members" ? await findMemberSenderAddress(db, group.groupId, senderAddress) : [],
	});
	if (allowed) return decision;
	console.warn(`Refused post to group ${group.address}`);
	return { action: "reject", rejectReason: GROUP_POST_REJECT_REASON, groupPolicy: true };
}

/**
 * Forwards to a Cloudflare Email Routing destination address. Returns whether the forward
 * succeeded so the caller can decide to still store the message.
 *
 * The destination must be a verified destination address in Cloudflare Email Routing.
 */
export async function forwardMessage(
	env: CloudflareEnv,
	message: ForwardableEmailMessage,
	destination: string,
): Promise<boolean> {
	try {
		const headers = new Headers();
		headers.set(MAILFLARE_FORWARDED_HEADER, await forwardedMarker(env));
		await message.forward(destination, headers);
		return true;
	} catch (error) {
		console.error(`Forwarding failed for ${message.to} -> ${destination}`, error);
		return false;
	}
}
