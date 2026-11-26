import { asc, and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailGroupMembers, mailGroups } from "@/db/schema";
import { boundParsedEmail } from "@/lib/email/inbound-limits";
import type { InboundQueueMessage } from "@/lib/email/inbound";
import { MimeLimitError, parseRawMime } from "@/lib/email/parse";
import { contentDigest, planQueueBatches } from "@/lib/groups/expand-utils";
import { singleSenderAddress } from "@/lib/groups/policy-utils";
import {
	parseRateKey,
	planRelayAllowance,
	relayBlockedByVerdicts,
	relayChunkKey,
	relayDelaySeconds,
	relayRateDayPrefix,
	relayRateKey,
	relayStorageKey,
	type RateEntry,
	type RelayAllowance,
} from "@/lib/groups/relay-utils";
import { domainCanSend } from "@/lib/groups/sending";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { analyzeSpam } from "@/lib/spam/engine";

type GroupRow = Pick<typeof mailGroups.$inferSelect, "id" | "domainId" | "localPart" | "name" | "disabled">;
const MAX_RATE_PAGES = 3;

/** Every marker under the day's prefix. `truncated` means there were more than we are willing to read. */
async function readRateEntries(env: CloudflareEnv, day: number): Promise<{ entries: RateEntry[]; truncated: boolean }> {
	const entries: RateEntry[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_RATE_PAGES; page += 1) {
		const listing = await env.BUCKET.list({ prefix: relayRateDayPrefix(day), cursor, limit: 1000 });
		for (const object of listing.objects) {
			const entry = parseRateKey(object.key);
			if (entry) entries.push(entry);
		}
		if (!listing.truncated || !("cursor" in listing) || !listing.cursor) return { entries, truncated: false };
		cursor = listing.cursor;
	}
	return { entries, truncated: true };
}

/**
 * Tells the admin that a cap stopped relays: an audit entry (`group.relay_capped`, shown on the group page), once per
 * group, scope and period so a spam run does not write one per message. The marker is what makes it once.
 */
async function notifyCapped(env: CloudflareEnv, group: GroupRow, address: string, tripped: Extract<RelayAllowance, { ok: false }>, bucket: { hour: number; day: number }): Promise<void> {
	const key = `group-relay/capnote/${group.id}-${tripped.scope}-${tripped.period}-${tripped.period === "hour" ? bucket.hour : bucket.day}`;
	if (await env.BUCKET.get(key)) return;
	await env.BUCKET.put(key, new ArrayBuffer(0));
	await createAuditLog(env, {
		actorUserId: null,
		action: "group.relay_capped",
		metadata: { groupId: group.id, address, scope: tripped.scope, period: tripped.period, limit: tripped.limit },
	});
}

/** The spam filters' verdict on a message, run once for the whole group instead of once per recipient mailbox. */
async function looksLikeSpam(db: AppDatabase, group: GroupRow, payload: InboundQueueMessage, content: ArrayBuffer): Promise<boolean> {
	try {
		const message = boundParsedEmail(await parseRawMime(content));
		const result = await analyzeSpam(db, {
			mailboxId: `group:${group.id}`,
			userId: `group:${group.id}`,
			envelopeFrom: payload.from,
			headers: payload.headers,
			verdicts: payload.verdicts,
			senderIp: payload.senderIp,
			message,
		});
		return result.verdict !== "inbox";
	} catch (error) {
		// Mail that cannot be parsed or judged is not sent on under our name.
		if (!(error instanceof MimeLimitError)) console.error(`Spam check of group mail failed for ${group.id}`, error);
		return true;
	}
}

type Context = { dmarcPass: boolean; cursor: string | undefined; loadBytes: () => Promise<ArrayBuffer | null> };

/**
 * Queues one `group.relay` message per external member of a chunk (spec D-7) and returns how many. Nothing is
 * relayed when the sender was not authenticated or has several From addresses, the receiver flagged the message, our
 * own spam filters put it aside, the domain cannot send, or a send cap is reached. A redelivered chunk finds its
 * marker and queues nothing: that is at most once on purpose, because SES and Cloudflare sending cannot deduplicate
 * and a repeat would be a second billed send.
 */
export async function queueRelays(
	env: CloudflareEnv,
	db: AppDatabase,
	group: GroupRow,
	payload: InboundQueueMessage,
	memberIds: string[],
	context: Context,
): Promise<number> {
	const skip = (reason: string) => {
		console.warn(`Group ${group.id}: ${reason}`);
		return 0;
	};
	if (!context.dmarcPass) return skip("mail without a DMARC pass goes to internal members only");
	if (!singleSenderAddress(payload.headers?.from)) return skip("mail without a single From address goes to internal members only");
	if (relayBlockedByVerdicts(payload.verdicts)) return skip("mail the receiver flagged goes to internal members only");
	const [domain] = await db.select().from(domains).where(eq(domains.id, group.domainId)).limit(1);
	if (!domain || !domainCanSend(domain)) return skip(`${domain?.hostname ?? "its domain"} cannot send, so external members are skipped`);
	const content = await context.loadBytes();
	if (!content) {
		console.error(`Missing R2 object for group mail: ${payload.rawR2Key}`);
		return 0;
	}
	const digest = await contentDigest(content);

	const chunkKey = await relayChunkKey(group.id, digest, context.cursor);
	if (await env.BUCKET.get(chunkKey)) return 0;

	const now = new Date();
	const hour = Math.floor(now.getTime() / 3_600_000);
	const day = Math.floor(hour / 24);
	const { entries, truncated } = await readRateEntries(env, day);
	const counted = entries.find((entry) => entry.groupId === group.id && entry.digest === digest);
	// All external members in id order: how many sends this message is, and each member's place in the spread-out release.
	const all = await db.select({ id: mailGroupMembers.id }).from(mailGroupMembers).where(and(eq(mailGroupMembers.groupId, group.id), eq(mailGroupMembers.kind, "external"))).orderBy(asc(mailGroupMembers.id));

	if (counted) {
		// A later chunk of a message already judged: reuse the verdict, do not count it again.
		if (counted.flag === "skip") return skip("mail our spam filters put aside goes to internal members only");
	} else {
		const allowance: RelayAllowance = truncated
			? { ok: false, scope: "installation", period: "day", limit: 0 }
			: planRelayAllowance(entries, { groupId: group.id, hour, day, sends: all.length });
		if (!allowance.ok) {
			await notifyCapped(env, group, `${group.localPart}@${domain.hostname}`.toLowerCase(), allowance, { hour, day });
			return skip(`the ${allowance.scope} limit of ${allowance.limit} relayed sends per ${allowance.period} is reached; external members are skipped`);
		}
		const spam = await looksLikeSpam(db, group, payload, content);
		await env.BUCKET.put(relayRateKey({ groupId: group.id, digest, sends: spam ? 0 : all.length, flag: spam ? "skip" : "ok", now }), new ArrayBuffer(0));
		if (spam) return skip("mail our spam filters put aside goes to internal members only");
	}

	// One shared copy per message, keyed by group and content so a later chunk writes the same object.
	const rawR2Key = await relayStorageKey(group.id, digest);
	await env.BUCKET.put(rawR2Key, content, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { from: payload.from, to: payload.to } });
	// Marked before queueing, not after: a failure in between loses this chunk's relays (logged by the retry) instead of billing them twice.
	await env.BUCKET.put(chunkKey, new ArrayBuffer(0));
	const order = new Map(all.map((row, index) => [row.id, index]));
	const relays = memberIds.map((memberId) => ({ body: { kind: "group.relay" as const, groupId: group.id, memberId, rawR2Key }, delaySeconds: relayDelaySeconds(order.get(memberId) ?? 0) }));
	for (const batch of planQueueBatches(relays)) await env.OUTBOUND_QUEUE.sendBatch(batch);
	return relays.length;
}
