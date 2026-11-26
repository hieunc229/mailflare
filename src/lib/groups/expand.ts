import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { getDb } from "@/db";
import { domains, mailGroupMembers, mailGroups, mailboxes, users } from "@/db/schema";
import type { InboundQueueMessage } from "@/lib/email/inbound";
import { inboundStorageKey } from "@/lib/email/inbound-id";
import { resolveMailboxForAddress, toResolvedMailbox, type ResolvedMailbox } from "@/lib/email/routing";
import { readTrustedDmarcResult } from "@/lib/spam/analyzers/authentication";
import { isMissingTableError } from "@/lib/database-errors";
import { groupsAllowed } from "@/lib/groups/license";
import {
	GROUP_RELAY_MESSAGES_PER_HOUR,
	relayBlockedByVerdicts,
	relayChunkKey,
	relayDelaySeconds,
	relayRatePrefix,
	relayStorageKey,
} from "@/lib/groups/relay-utils";
import { domainCanSend } from "@/lib/groups/sending";
import { singleSenderAddress } from "@/lib/groups/policy-utils";
import {
	EXPANSION_DEFER_SECONDS,
	GROUP_EXPANSION_CHUNK,
	contentDigest,
	groupCopyKey,
	reserveExpansion,
	type ExpansionBudget,
	isAccountPrimaryAddress,
	planChunk,
	planDeliveries,
	planQueueBatches,
} from "@/lib/groups/expand-utils";

type MemberRow = typeof mailGroupMembers.$inferSelect;

async function loadGroup(db: AppDatabase, groupId: string) {
	try {
		const [group] = await db.select().from(mailGroups).where(eq(mailGroups.id, groupId)).limit(1);
		return group ?? null;
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
}

/**
 * The mailboxes a chunk of members delivers to. A user member delivers to the mailbox whose address is
 * the account's email, a mailbox member to that mailbox. Disabled accounts and mailboxes are skipped.
 * Queries are bounded by the chunk size, well under D1's 100 bound parameters.
 */
async function resolveMemberMailboxIds(db: AppDatabase, members: MemberRow[]): Promise<{ mailboxId: string }[]> {
	const userIds = members.flatMap((member) => (member.kind === "user" && member.userId ? [member.userId] : []));
	const mailboxIds = members.flatMap((member) => (member.kind === "mailbox" && member.mailboxId ? [member.mailboxId] : []));
	const targets: { mailboxId: string }[] = [];
	if (mailboxIds.length) {
		const rows = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(inArray(mailboxes.id, mailboxIds), eq(mailboxes.disabled, false)));
		targets.push(...rows.map((row) => ({ mailboxId: row.id })));
	}
	if (userIds.length) {
		const accounts = await db.select({ id: users.id, email: users.email }).from(users).where(and(inArray(users.id, userIds), eq(users.disabled, false)));
		if (accounts.length) {
			const owned = await db
				.select({ id: mailboxes.id, userId: mailboxes.userId, localPart: mailboxes.localPart, hostname: domains.hostname })
				.from(mailboxes)
				.innerJoin(domains, eq(mailboxes.domainId, domains.id))
				.where(and(inArray(mailboxes.userId, accounts.map((account) => account.id)), eq(mailboxes.disabled, false)));
			for (const account of accounts) {
				const own = owned.find((mailbox) => mailbox.userId === account.id && isAccountPrimaryAddress(mailbox.localPart, mailbox.hostname, account.email));
				if (own) targets.push({ mailboxId: own.id });
			}
		}
	}
	return targets;
}

/**
 * The mailbox a copy of group mail may still be stored in: the group is enabled, the mailbox is
 * enabled, and the mailbox is still a member (or its account is a user member whose own address it is).
 */
export async function resolveGroupDelivery(
	db: AppDatabase,
	delivery: { groupId: string; mailboxId: string },
): Promise<ResolvedMailbox | null> {
	const group = await loadGroup(db, delivery.groupId);
	if (!group || group.disabled) return null;
	const [mailbox] = await db.select().from(mailboxes).where(and(eq(mailboxes.id, delivery.mailboxId), eq(mailboxes.disabled, false))).limit(1);
	if (!mailbox) return null;
	const members = await db
		.select()
		.from(mailGroupMembers)
		.where(and(
			eq(mailGroupMembers.groupId, group.id),
			or(eq(mailGroupMembers.mailboxId, mailbox.id), eq(mailGroupMembers.userId, mailbox.userId)),
		));
	const [domain] = await db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.id, mailbox.domainId)).limit(1);
	if (!domain) return null;
	let isTarget = members.some((member) => member.kind === "mailbox" && member.mailboxId === mailbox.id);
	if (!isTarget && members.some((member) => member.kind === "user" && member.userId === mailbox.userId)) {
		const [account] = await db.select({ email: users.email }).from(users).where(and(eq(users.id, mailbox.userId), eq(users.disabled, false))).limit(1);
		isTarget = !!account && isAccountPrimaryAddress(mailbox.localPart, domain.hostname, account.email);
	}
	return isTarget ? toResolvedMailbox(mailbox, mailbox.domainId, domain.hostname) : null;
}

/**
 * Queues one `group.relay` message per external member of a chunk (spec D-7) and returns how many. Skipped, with a
 * warning, when the sender was not authenticated, the receiver flagged the message, the domain cannot send, or the
 * group used up its hourly allowance. Redelivery of the same chunk finds its marker and queues nothing.
 */
async function queueRelays(
	env: CloudflareEnv,
	db: AppDatabase,
	group: { id: string; domainId: string },
	payload: InboundQueueMessage,
	memberIds: string[],
	context: { dmarcPass: boolean; cursor: string | undefined; loadBytes: () => Promise<ArrayBuffer | null> },
): Promise<number> {
	const skip = (reason: string) => {
		console.warn(`Group ${group.id}: ${reason}`);
		return 0;
	};
	if (!context.dmarcPass) return skip("mail without a DMARC pass goes to internal members only");
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
	const prefix = relayRatePrefix(group.id, Math.floor(Date.now() / 3_600_000));
	const rateKey = `${prefix}${digest}`;
	const counted = await env.BUCKET.list({ prefix, limit: GROUP_RELAY_MESSAGES_PER_HOUR + 1 });
	if (!counted.objects.some((object) => object.key === rateKey)) {
		if (counted.objects.length >= GROUP_RELAY_MESSAGES_PER_HOUR) return skip(`${GROUP_RELAY_MESSAGES_PER_HOUR} messages were relayed this hour already; external members are skipped`);
		await env.BUCKET.put(rateKey, new ArrayBuffer(0));
	}
	// One shared copy per message, keyed by group and content so a retried chunk writes the same object.
	const rawR2Key = await relayStorageKey(group.id, digest);
	await env.BUCKET.put(rawR2Key, content, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { from: payload.from, to: payload.to } });
	const relays = memberIds.map((memberId, index) => ({ body: { kind: "group.relay" as const, groupId: group.id, memberId, rawR2Key }, delaySeconds: relayDelaySeconds(index) }));
	for (const batch of planQueueBatches(relays)) await env.OUTBOUND_QUEUE.sendBatch(batch);
	await env.BUCKET.put(chunkKey, new ArrayBuffer(0));
	return relays.length;
}

/**
 * Expands group mail that the live handler admitted into one queue message per member mailbox
 * (spec D-4, D-6). Handles one chunk of `GROUP_EXPANSION_CHUNK` members, then enqueues itself with
 * a cursor for the next. Every key and message is deterministic, so a redelivered chunk is harmless.
 * External members get one `group.relay` message each on the outbound queue (spec D-7), sharing one relay copy.
 */
export async function expandGroupDelivery(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	options: { budget?: ExpansionBudget } = {},
): Promise<void> {
	const expansion = payload.groupExpansion;
	if (!expansion) return;
	// Over this batch's subrequest budget: offer the same chunk again shortly instead of failing it.
	if (options.budget && !reserveExpansion(options.budget)) {
		await env.INBOUND_QUEUE.send(payload, { delaySeconds: EXPANSION_DEFER_SECONDS });
		return;
	}
	const db = getDb(env);
	const dropRaw = () => env.BUCKET.delete(payload.rawR2Key).catch((error) => console.error(`Raw cleanup failed for ${payload.rawR2Key}`, error));

	const group = await loadGroup(db, expansion.groupId);
	if (!group || group.disabled || !(await groupsAllowed(env)())) {
		console.warn(`Group ${expansion.groupId} cannot receive mail; dropping ${payload.rawR2Key}`);
		await dropRaw();
		return;
	}

	// Ordered by id with a cursor, so a member added mid-expansion is picked up or not, never delivered twice.
	const rows = await db
		.select()
		.from(mailGroupMembers)
		.where(and(
			eq(mailGroupMembers.groupId, group.id),
			expansion.cursor ? gt(mailGroupMembers.id, expansion.cursor) : undefined,
		))
		.orderBy(asc(mailGroupMembers.id))
		.limit(GROUP_EXPANSION_CHUNK + 1);
	const { chunk, nextCursor } = planChunk(rows, GROUP_EXPANSION_CHUNK);

	// The poster already has a Sent copy; only a trusted DMARC pass says the From really is theirs.
	const fromAddress = singleSenderAddress(payload.headers?.from);
	const dmarcPass = readTrustedDmarcResult(payload.headers, payload.verdicts) === "pass";
	const senderMailbox = fromAddress && dmarcPass
		? await resolveMailboxForAddress(db, fromAddress)
		: null;
	const mailboxIds = planDeliveries(await resolveMemberMailboxIds(db, chunk), senderMailbox?.id ?? null);
	// External members get a re-sent copy, and only of mail whose sender the receiver authenticated (spec D-7): relaying
	// spam or a spoof from our domain would hurt its sending reputation. The poster does not get their own post back.
	const externalIds = chunk.flatMap((member) => (member.kind === "external" && member.email && !(dmarcPass && member.email === fromAddress) ? [member.id] : []));

	let bytes: ArrayBuffer | null = null;
	const loadBytes = async () => {
		if (bytes) return bytes;
		const raw = await env.BUCKET.get(payload.rawR2Key);
		bytes = raw ? await raw.arrayBuffer() : null;
		return bytes;
	};
	const missing = () => console.error(`Missing R2 object for group mail: ${payload.rawR2Key}`);

	if (mailboxIds.length) {
		const content = await loadBytes();
		if (!content) {
			// An earlier attempt of the last chunk already deleted it, or it was swept: nothing left to copy.
			return missing();
		}
		const digest = await contentDigest(content);
		const { groupExpansion: _expansion, ...base } = payload;
		void _expansion;
		const messages: { body: InboundQueueMessage }[] = [];
		for (const mailboxId of mailboxIds) {
			const rawR2Key = await groupCopyKey(digest, mailboxId);
			await env.BUCKET.put(rawR2Key, content, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { from: payload.from, to: payload.to } });
			messages.push({ body: { ...base, rawR2Key, groupDelivery: { groupId: group.id, mailboxId } } });
		}
		for (const batch of planQueueBatches(messages)) await env.INBOUND_QUEUE.sendBatch(batch);
	}

	// Last, after the internal copies: queueing relays is the one step a retried chunk must not repeat.
	const relayed = externalIds.length ? await queueRelays(env, db, group, payload, externalIds, { dmarcPass, cursor: expansion.cursor, loadBytes }) : 0;
	if (!mailboxIds.length && !relayed && !nextCursor && !expansion.cursor) console.warn(`Group ${group.id} has no deliverable members`);

	if (nextCursor) {
		await env.INBOUND_QUEUE.send({ ...payload, groupExpansion: { groupId: group.id, cursor: nextCursor } });
		return;
	}
	await dropRaw();
}

/**
 * Copies group mail to the group's own raw key before it is expanded. The queued key can be shared
 * with other recipients of the message (intake keys it per mailbox, and a failed routing lookup
 * left it unscoped), and the last chunk deletes the original. Idempotent: a retry rewrites the same key.
 * Returns null when the raw object is gone.
 */
export async function scopeRawToGroup(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	groupId: string,
): Promise<{ payload: InboundQueueMessage; bytes: ArrayBuffer } | null> {
	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) return null;
	const bytes = await raw.arrayBuffer();
	const rawR2Key = await inboundStorageKey(bytes, `group:${groupId}`);
	await env.BUCKET.put(rawR2Key, bytes, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { from: payload.from, to: payload.to } });
	return { payload: { ...payload, rawR2Key, groupExpansion: { groupId } }, bytes };
}
