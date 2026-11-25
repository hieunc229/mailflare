import { getDb } from "@/db";
import { recordRuleMatch, resolveInboundAddress, type RoutingDecision } from "@/lib/email/routing";
import { matchReportAddress } from "@/lib/deliverability/report-address";
import { forwardedMarker, MAILFLARE_FORWARDED_HEADER } from "@/lib/email/account-forwarding";

/** A routing decision, or `report`: DMARC report mail, which only the report queue consumer may touch. */
export type IncomingDecision = RoutingDecision | { action: "report" };

/**
 * Resolves the routing decision for a live inbound message. Used by the Worker `email`
 * handler, where `forward()` and `setReject()` are still available on the message.
 *
 * Never throws: a routing failure must not stop mail from being stored.
 */
export async function resolveIncomingMail(
	env: CloudflareEnv,
	from: string,
	to: string,
	headers?: { subject?: string | null; from?: string | null; alreadyForwarded?: boolean; all?: Record<string, string> },
): Promise<IncomingDecision | null> {
	try {
		const db = getDb(env);
		// A DMARC report address is never a mailbox: no reject or forward rule (a catch-all included), and no account
		// forwarding, may apply to it. Callers store it and queue it for the report consumer, nothing else.
		if (await matchReportAddress(env, to)) return { action: "report" };
		const decision = await resolveInboundAddress(db, to, from, {
			headers: headers?.all,
			// A message that already went through a forward is never forwarded again by a
			// mailbox rule, so two inboxes forwarding to each other cannot loop.
			mailboxForwards: headers?.alreadyForwarded ? undefined : { subject: headers?.subject, from: headers?.from },
		});
		if (decision?.ruleId) {
			await recordRuleMatch(db, decision.ruleId).catch(() => undefined);
		}
		return decision;
	} catch (error) {
		console.error(`Routing resolution failed for ${to}`, error);
		return null;
	}
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
