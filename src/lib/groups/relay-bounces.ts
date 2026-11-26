import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailGroupMembers } from "@/db/schema";
import { getSuppressionMode, recordSuppression } from "@/lib/deliverability/suppression";
import { cleanAddress } from "@/lib/deliverability/suppression-utils";
import { parseDeliveryStatus } from "@/lib/deliverability/dsn";
import { parseMessageIdList } from "@/lib/email/threading";
import { relayMessageIdKeys } from "@/lib/groups/relay-utils";

type RelayedCopy = { groupId: string; memberId: string };

/** The member a Message-ID was relayed to (see `relayMessageIdKey`), or null for any other ID. */
async function relayedCopy(env: CloudflareEnv, messageId: string): Promise<RelayedCopy | null> {
	let stored: Awaited<ReturnType<R2Bucket["get"]>> = null;
	// Recorded on the day it was sent; a bounce may arrive a few days later.
	for (const key of await relayMessageIdKeys(messageId)) {
		stored = await env.BUCKET.get(key);
		if (stored) break;
	}
	if (!stored) return null;
	try {
		const value = JSON.parse(new TextDecoder().decode(await stored.arrayBuffer())) as { g?: unknown; m?: unknown };
		return typeof value.g === "string" && typeof value.m === "string" ? { groupId: value.g, memberId: value.m } : null;
	} catch {
		return null;
	}
}

/**
 * A bounce that comes back to the group address. When it names the Message-ID of a copy we relayed to one member
 * of this group, and its failed recipient is that member's own address, the address is suppressed: Cloudflare sending
 * reports bounces to the From address, so this is the only way they reach the list. Only a permanent failure (5.x.x)
 * counts, and only the Message-IDs we wrote down can match, so a forged bounce cannot name anyone else.
 */
export async function recordRelayBounce(env: CloudflareEnv, group: { groupId: string; domainId: string }, raw: ArrayBuffer): Promise<void> {
	if ((await getSuppressionMode(env)) === "off") return;
	const status = parseDeliveryStatus(raw);
	if (!status?.originalMessageId) return;
	const failed = status.recipients.filter((recipient) => recipient.action === "failed" && /^5\.\d+\.\d+$/.test(recipient.status));
	if (!failed.length) return;
	const copy = await relayedCopy(env, status.originalMessageId);
	if (!copy || copy.groupId !== group.groupId) return;
	const [member] = await getDb(env)
		.select({ email: mailGroupMembers.email })
		.from(mailGroupMembers)
		.where(and(eq(mailGroupMembers.id, copy.memberId), eq(mailGroupMembers.groupId, group.groupId), eq(mailGroupMembers.kind, "external")))
		.limit(1);
	if (!member?.email) return;
	const hit = failed.find((recipient) => cleanAddress(recipient.finalRecipient) === member.email);
	if (!hit) return;
	// Unconfirmed, like every DSN-derived entry: our relayed Message-IDs are visible to members (References, Reply-To),
	// so a forged bounce can name one. It is enforced once a second bounce names a different copy, or an admin confirms it.
	await recordSuppression(env, { domainId: group.domainId, email: member.email, reason: "hard_bounce", source: "dsn", detail: hit.diagnostic, confirmed: false, evidenceRef: status.originalMessageId });
}

/**
 * Whether the mail answers a copy we relayed for this group: its In-Reply-To or References names a Message-ID we
 * wrote down. An auto-acknowledgement does, whatever address it is sent from, which the sender check cannot see.
 */
export async function answersRelayedCopy(env: CloudflareEnv, groupId: string, headers: Record<string, string>): Promise<boolean> {
	const get = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
	// The newest references are the nearest ancestors; three lookups bound the cost.
	const ids = [...parseMessageIdList(get("in-reply-to")), ...parseMessageIdList(get("references")).slice(-3)];
	for (const id of [...new Set(ids)].slice(0, 4)) {
		const copy = await relayedCopy(env, id);
		if (copy?.groupId === groupId) return true;
	}
	return false;
}
