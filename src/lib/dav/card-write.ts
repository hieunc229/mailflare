import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { davCards, davChanges } from "@/db/schema";
import { newId } from "@/lib/ids";
import { parseCard } from "./card-parse";
import { mirrorCardStatements, ownAddresses, unlinkCardStatement } from "./contact-mirror";
import { cardUsage, loadCardMetaByNames, MAX_CARDS } from "./card-store";
import { addressBookCollectionId, etagFromSeq, etagSeqs } from "./changes";
import { BASE_HEADERS, precondition, text, XML_HEADERS } from "./common";
import { collectionPath, type DavContext } from "./collections";
import { created, failedPrecondition, insufficientStorage, MAX_CARD_BYTES, readPutBody, replaced, staleGuard } from "./writes";
import { escapeXml } from "./xml-writer";
import { isUniqueConstraintError } from "@/lib/database-errors";

/** RFC 6352 6.3.2.1: the UID is taken by another card, whose href goes in the error. */
const conflict = (href: string) =>
	new Response(`<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav"><CR:no-uid-conflict><D:href>${escapeXml(href)}</D:href></CR:no-uid-conflict></D:error>`, { status: 403, headers: XML_HEADERS });

/** The newest change number of a card, which is its ETag (undefined: the log has none, so the update time stands in). */
const seqOf = async (ctx: DavContext, card: { id: string } | undefined) => (card ? (await etagSeqs(ctx.env, addressBookCollectionId(ctx.userId), [card.id])).get(card.id) : undefined);

/**
 * PUT of one card (spec 8.2): size and type checked while reading, parsed, preconditions, the UID rules, the user's limits
 * (5000 cards and 20 MB, 507; checked just before the batch, so two simultaneous writes can overshoot by one card), then one
 * batch that starts with the guard of `staleGuard` (the card must still be as it was read, else 412): the row, and a SELECT
 * of its newest change number, which is the ETag. The body is stored exactly as received. The card's addresses are mirrored
 * into `contacts` in the same batch (spec 8.2, `mirrorCardStatements`).
 */
export async function putCard(ctx: DavContext, name: string, request: Request): Promise<Response> {
	const body = await readPutBody(request, ["text/vcard", "text/x-vcard"]);
	if (body instanceof Response) return body;
	const parsed = parseCard(body);
	if ("error" in parsed) return precondition(403, parsed.error, "CR");

	const { env, userId } = ctx;
	const cid = addressBookCollectionId(userId);
	const [existing] = await loadCardMetaByNames(env, userId, [name]);
	const seq = await seqOf(ctx, existing);
	const refused = failedPrecondition(request, existing ? etagFromSeq(seq, existing.updatedAt) : null);
	if (refused) return refused;
	const db = getDb(env);
	const [other] = await db.select({ name: davCards.name }).from(davCards).where(and(eq(davCards.userId, userId), eq(davCards.collectionId, cid), eq(davCards.uid, parsed.uid), existing ? ne(davCards.id, existing.id) : undefined)).limit(1);
	if (other) return conflict(collectionPath("addressbooks", userId) + other.name);
	// A card keeps its UID (RFC 6352 6.3.2.1).
	if (existing && existing.uid !== parsed.uid) return conflict(collectionPath("addressbooks", userId) + existing.name);
	const size = new TextEncoder().encode(body).byteLength;
	if (!existing || size > existing.size) {
		const usage = await cardUsage(env, userId);
		if ((!existing && usage.count >= MAX_CARDS) || usage.bytes - (existing?.size ?? 0) + size > MAX_CARD_BYTES) return insufficientStorage("The address book");
	}

	const now = new Date(Math.floor(Date.now() / 1000) * 1000);
	const values = { uid: parsed.uid, body, version: parsed.version, fn: parsed.fn, emails: JSON.stringify(parsed.emails), size, updatedAt: now };
	const id = existing?.id ?? newId("card");
	const own = parsed.group || !parsed.emails.length ? new Set<string>() : await ownAddresses(env, userId, parsed.emails);
	const write = existing ? db.update(davCards).set(values).where(and(eq(davCards.id, id), eq(davCards.userId, userId))) : db.insert(davCards).values({ ...values, id, userId, collectionId: cid, name, createdAt: now });
	let results: unknown[];
	try {
		results = (await db.batch([...(existing ? staleGuard(db, davCards, cid, id, userId, { seq: seq ?? null, updatedAt: existing.updatedAt }) : []), write, ...mirrorCardStatements(db, userId, { id, fn: parsed.fn, emails: parsed.emails, group: parsed.group, own }), db.select({ seq: sql<number | null>`max(${davChanges.seq})` }).from(davChanges).where(and(eq(davChanges.collectionId, cid), eq(davChanges.objectKey, id)))] as never)) as unknown[];
	} catch (error) {
		// Two writes raced for the same name or UID; the loser is refused like a failed precondition.
		if (isUniqueConstraintError(error)) return text(412, "Precondition failed");
		throw error;
	}
	const [last] = results[results.length - 1] as { seq: number | null }[];
	const etag = etagFromSeq(last?.seq, now);
	return existing ? replaced(etag) : created(etag);
}

/** DELETE of one card, guarded like a PUT. */
export async function deleteCard(ctx: DavContext, name: string, request: Request): Promise<Response> {
	const [existing] = await loadCardMetaByNames(ctx.env, ctx.userId, [name]);
	const seq = await seqOf(ctx, existing);
	const refused = failedPrecondition(request, existing ? etagFromSeq(seq, existing.updatedAt) : null);
	if (refused) return refused;
	if (!existing) return text(404, "Not found");
	const db = getDb(ctx.env);
	try {
		await db.batch([...staleGuard(db, davCards, addressBookCollectionId(ctx.userId), existing.id, ctx.userId, { seq: seq ?? null, updatedAt: existing.updatedAt }), db.delete(davCards).where(and(eq(davCards.id, existing.id), eq(davCards.userId, ctx.userId))), unlinkCardStatement(db, ctx.userId, existing.id)] as never);
	} catch (error) {
		// Changed or removed since it was read.
		if (isUniqueConstraintError(error)) return text(412, "Precondition failed");
		throw error;
	}
	return new Response(null, { status: 204, headers: BASE_HEADERS });
}
