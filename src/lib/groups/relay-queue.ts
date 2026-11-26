import { asc, and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailGroupMembers, mailGroups } from "@/db/schema";
import { boundParsedEmail } from "@/lib/email/inbound-limits";
import type { InboundQueueMessage } from "@/lib/email/inbound";
import { MimeLimitError, parseRawMime } from "@/lib/email/parse";
import { contentDigest, planQueueBatches } from "@/lib/groups/expand-utils";
import { singleSenderAddress } from "@/lib/groups/policy-utils";
import {
	dayOf,
	parseRateKey,
	planRelayAllowance,
	relayBlockedByVerdicts,
	relayCapNoteKey,
	relayCaps,
	relayChunkKey,
	relayDelaySeconds,
	relayRateDayPrefix,
	relayRateKey,
	relaySkipKey,
	relayStorageKey,
	type RateEntry,
	type RelayAllowance,
} from "@/lib/groups/relay-utils";
import { domainCanSend } from "@/lib/groups/sending";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { analyzeSpam } from "@/lib/spam/engine";
import { ExternalSpamIntelligenceProvider } from "@/lib/spam/providers/external";
import { getSpamIntelligenceConfig } from "@/lib/spam/settings";

type GroupRow = Pick<typeof mailGroups.$inferSelect, "id" | "domainId" | "localPart" | "name" | "disabled">;
const MAX_RATE_PAGES = 3;
/** Sends reserved by this group in the last two minutes put a new message's relays behind them. */
const RECENT_MS = 120_000;

/** Every marker under the day's rate prefix. `truncated` means there were more than we are willing to read. */
async function readRateEntries(env: CloudflareEnv, day: number): Promise<{ entries: RateEntry[]; truncated: boolean }> {
	// One entry per message and group: the approved marker, if the reserved one has not been removed yet, stands for both.
	const found = new Map<string, RateEntry>();
	const result = (truncated: boolean) => ({ entries: [...found.values()], truncated });
	let cursor: string | undefined;
	for (let page = 0; page < MAX_RATE_PAGES; page += 1) {
		const listing = await env.BUCKET.list({ prefix: relayRateDayPrefix(day), cursor, limit: 1000 });
		for (const object of listing.objects) {
			const entry = parseRateKey(object.key);
			if (!entry) continue;
			const id = `${entry.groupId}/${entry.digest}`;
			if (found.get(id)?.state !== "approved") found.set(id, { ...entry, uploaded: object.uploaded });
		}
		if (!listing.truncated || !("cursor" in listing) || !listing.cursor) return result(false);
		cursor = listing.cursor;
	}
	return result(true);
}

/**
 * Tells the admin that a cap stopped relays: an audit entry (`group.relay_capped`, shown on the group page), once per
 * group, scope and period so a spam run does not write one per message. The marker is what makes it once.
 */
async function notifyCapped(env: CloudflareEnv, group: GroupRow, address: string, tripped: Extract<RelayAllowance, { ok: false }>, bucket: { hour: number; day: number }): Promise<void> {
	const key = relayCapNoteKey(group.id, tripped.scope, tripped.period, tripped.period === "hour" ? bucket.hour : bucket.day);
	if (await env.BUCKET.get(key)) return;
	await env.BUCKET.put(key, new ArrayBuffer(0));
	await createAuditLog(env, {
		actorUserId: null,
		action: "group.relay_capped",
		metadata: { groupId: group.id, address, scope: tripped.scope, period: tripped.period, limit: tripped.limit },
	});
}

/**
 * The spam filters' verdict on a message, run once for the whole group instead of once per recipient mailbox, with
 * the same intelligence providers (blocklists, brands) that filter inbound mail. Only `spam` blocks: a `suspicious`
 * message is what a mailbox would show with a warning, not what it would refuse. Mail that cannot be parsed or judged
 * is not sent on under our name.
 */
async function judgeSpam(env: CloudflareEnv, db: AppDatabase, group: GroupRow, payload: InboundQueueMessage, content: ArrayBuffer): Promise<{ spam: boolean; reason: string }> {
	try {
		const message = boundParsedEmail(await parseRawMime(content));
		const intelligence = await getSpamIntelligenceConfig(env);
		const result = await analyzeSpam(db, {
			mailboxId: `group:${group.id}`,
			userId: `group:${group.id}`,
			envelopeFrom: payload.from,
			headers: payload.headers,
			verdicts: payload.verdicts,
			senderIp: payload.senderIp,
			brands: intelligence.brands,
			message,
			intelligenceProvider: new ExternalSpamIntelligenceProvider(intelligence, env.BUCKET),
		});
		return { spam: result.verdict === "spam", reason: `spam score ${result.score}` };
	} catch (error) {
		if (!(error instanceof MimeLimitError)) console.error(`Spam check of group mail failed for ${group.id}`, error);
		return { spam: true, reason: error instanceof MimeLimitError ? "message too complex to check" : "spam check failed" };
	}
}

type Context = { dmarcPass: boolean; cursor: string | undefined; loadBytes: () => Promise<ArrayBuffer | null> };

/**
 * Queues one `group.relay` message per external member of a chunk (spec D-7) and returns how many. Nothing is
 * relayed when the sender was not authenticated or has several From addresses, the receiver flagged the message, our
 * own spam filters call it spam, the domain cannot send, or a send cap is reached.
 *
 * A chunk is marked before its relays are queued, and a redelivered chunk that finds the mark queues nothing. That is
 * at most once on purpose: SES and Cloudflare sending cannot deduplicate, so a repeat would be a second billed send,
 * and the price is that members of a chunk whose queueing failed part-way miss that message. The retry logs it.
 *
 * Caps hold under concurrency by reserving first: the message's sends are written as a marker, the markers are
 * listed again, and a message that finds itself over a cap removes its marker and relays nothing. Two messages
 * reserving at the same instant may both back out (they see each other); neither can both go over.
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
	const address = `${group.localPart}@${domain.hostname}`.toLowerCase();

	const now = new Date();
	const hour = Math.floor(now.getTime() / 3_600_000);
	const day = dayOf(now);
	const chunkKey = await relayChunkKey(group.id, digest, context.cursor, now);
	// A marker written just before UTC midnight is under yesterday's day: look there too.
	const yesterday = new Date(now.getTime() - 86_400_000);
	const marked = async (keys: string[]) => (await Promise.all(keys.map((key) => env.BUCKET.get(key)))).some((object) => object !== null);
	if (await marked([chunkKey, await relayChunkKey(group.id, digest, context.cursor, yesterday)])) {
		console.warn(`Group ${group.id}: a chunk of ${payload.rawR2Key} was queued before (or lost, if that attempt failed after marking it); not queueing it again`);
		return 0;
	}
	if (await marked([relaySkipKey(group.id, digest, now), relaySkipKey(group.id, digest, yesterday)])) return skip("mail our spam filters put aside goes to internal members only");

	const caps = relayCaps(env);
	const { entries, truncated } = await readRateEntries(env, day);
	const own = (entry: RateEntry) => entry.groupId === group.id && entry.digest === digest;
	// All external members in id order: how many sends this message is, and each member's place in the spread-out release.
	const all = await db.select({ id: mailGroupMembers.id }).from(mailGroupMembers).where(and(eq(mailGroupMembers.groupId, group.id), eq(mailGroupMembers.kind, "external"))).orderBy(asc(mailGroupMembers.id));
	let ahead = 0;

	// Only an approved marker says the message was judged; a reservation may be what an attempt left when it died.
	if (entries.find(own)?.state !== "approved") {
		const check = (list: RateEntry[], over: boolean): RelayAllowance => (over ? { ok: false, scope: "installation", period: "day", limit: 0 } : planRelayAllowance(list.filter((entry) => !own(entry)), { groupId: group.id, hour, day, sends: all.length }, caps));
		const early = check(entries, truncated);
		if (!early.ok) {
			await notifyCapped(env, group, address, early, { hour, day });
			return skip(`the ${early.scope} limit of ${early.limit} relayed sends per ${early.period} is reached; external members are skipped`);
		}
		ahead = entries.filter((entry) => !own(entry) && entry.groupId === group.id && entry.uploaded && now.getTime() - entry.uploaded.getTime() < RECENT_MS).reduce((sum, entry) => sum + entry.sends, 0);
		// Reserve, then look again: the check above cannot see a message that reserved at the same moment.
		const reservation = relayRateKey({ groupId: group.id, digest, sends: all.length, state: "reserved", now });
		await env.BUCKET.put(reservation, new ArrayBuffer(0));
		const again = await readRateEntries(env, day);
		const final = check(again.entries, again.truncated);
		if (!final.ok) {
			// Backing out: another message reserved at the same moment. That is contention, not a cap being reached, so no notice.
			await env.BUCKET.delete(reservation);
			return skip(`the ${final.scope} limit of ${final.limit} relayed sends per ${final.period} is reached; external members are skipped`);
		}
		const verdict = await judgeSpam(env, db, group, payload, content);
		if (verdict.spam) {
			// Give the sends back and remember the verdict, away from the cap counters.
			await env.BUCKET.delete(reservation);
			await env.BUCKET.put(relaySkipKey(group.id, digest, now), new ArrayBuffer(0));
			await createAuditLog(env, { actorUserId: null, action: "group.relay_blocked", metadata: { groupId: group.id, address, reason: verdict.reason } });
			return skip(`our spam filters blocked the relay (${verdict.reason}); external members are skipped`);
		}
		await env.BUCKET.put(relayRateKey({ groupId: group.id, digest, sends: all.length, state: "approved", now }), new ArrayBuffer(0));
		await env.BUCKET.delete(reservation);
	}

	// One shared copy per message, keyed by group and content so a later chunk writes the same object.
	const rawR2Key = await relayStorageKey(group.id, digest, now);
	await env.BUCKET.put(rawR2Key, content, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { from: payload.from, to: payload.to } });
	await env.BUCKET.put(chunkKey, new ArrayBuffer(0));
	const order = new Map(all.map((row, index) => [row.id, index]));
	const relays = memberIds.map((memberId) => ({ body: { kind: "group.relay" as const, groupId: group.id, memberId, rawR2Key }, delaySeconds: relayDelaySeconds(order.get(memberId) ?? 0, ahead) }));
	for (const batch of planQueueBatches(relays)) await env.OUTBOUND_QUEUE.sendBatch(batch);
	return relays.length;
}
