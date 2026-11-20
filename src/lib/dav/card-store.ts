import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { davCards } from "@/db/schema";
import { addressBookCollectionId, etagFromSeq, newestSeqOf } from "./changes";
import type { ListedRow } from "./common";

type Env = Pick<CloudflareEnv, "DB">;

/** Names per query: the chunk plus the user and the collection stay under D1's 100 bound parameters. */
export const CARD_CHUNK = 80;
/** Cards listed or filtered per request (the per-user card limit of the spec); more is 507. */
export const MAX_CARDS = 5000;
/** A chunk of bodies is cut at this many bytes (always at least one card), so 80 large cards never sit in memory together. */
const CHUNK_BYTES = 4 * 1024 * 1024;

export type CardMeta = { id: string; name: string; uid: string; fn: string; emails: string[]; version: "3.0" | "4.0"; size: number; updatedAt: Date };
export type Card = CardMeta & { body: string };

const columns = { id: davCards.id, name: davCards.name, uid: davCards.uid, fn: davCards.fn, emails: davCards.emails, version: davCards.version, size: davCards.size, updatedAt: davCards.updatedAt };
const mine = (userId: string) => and(eq(davCards.userId, userId), eq(davCards.collectionId, addressBookCollectionId(userId)));

function emails(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

const toMeta = (row: Omit<CardMeta, "emails"> & { emails: string }): CardMeta => ({ ...row, emails: emails(row.emails) });

/** How many cards the address book has. */
export async function countCards(env: Env, userId: string): Promise<number> {
	const [row] = await getDb(env).select({ count: sql<number>`count(*)` }).from(davCards).where(mine(userId));
	return Number(row?.count ?? 0);
}

/** Every card's name, size and ETag, in pages of `page` by name (keyset): one statement a page, for PROPFIND depth 1 and the first sync. Stops at `max`. */
export async function* pageCards(env: Env, userId: string, page: number, max: number): AsyncGenerator<ListedRow[]> {
	let after = "";
	for (let listed = 0; listed < max; ) {
		const rows = await getDb(env)
			.select({ name: davCards.name, size: davCards.size, updatedAt: davCards.updatedAt, seq: newestSeqOf(addressBookCollectionId(userId), davCards.id) })
			.from(davCards)
			.where(and(mine(userId), gt(davCards.name, after)))
			.orderBy(asc(davCards.name))
			.limit(page);
		if (!rows.length) return;
		yield rows.map((row) => ({ name: row.name, size: row.size, updatedAt: row.updatedAt, etag: etagFromSeq(row.seq, row.updatedAt) }));
		if (rows.length < page) return;
		listed += rows.length;
		after = rows[rows.length - 1].name;
	}
}

/** Card metadata (no bodies), by name order; one more than `limit` so the caller can tell it was cut. */
export async function listCards(env: Env, userId: string, limit: number): Promise<CardMeta[]> {
	const rows = await getDb(env).select(columns).from(davCards).where(mine(userId)).orderBy(asc(davCards.name)).limit(limit + 1);
	return rows.map(toMeta);
}

export async function loadCardMetaByNames(env: Env, userId: string, names: string[]): Promise<CardMeta[]> {
	const found: CardMeta[] = [];
	for (let i = 0; i < names.length; i += CARD_CHUNK) {
		const rows = await getDb(env).select(columns).from(davCards).where(and(mine(userId), inArray(davCards.name, names.slice(i, i + CARD_CHUNK)))).orderBy(asc(davCards.name));
		found.push(...rows.map(toMeta));
	}
	return found;
}

/** Groups of cards that are loaded together: at most CARD_CHUNK cards and CHUNK_BYTES of bodies, from the sizes already known. */
export function planCardChunks(cards: CardMeta[]): CardMeta[][] {
	const chunks: CardMeta[][] = [];
	let current: CardMeta[] = [];
	let bytes = 0;
	for (const card of cards) {
		if (current.length && (current.length >= CARD_CHUNK || bytes + card.size > CHUNK_BYTES)) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(card);
		bytes += card.size;
	}
	if (current.length) chunks.push(current);
	return chunks;
}

export async function loadCardBodies(env: Env, userId: string, cards: CardMeta[]): Promise<Card[]> {
	const rows = await getDb(env).select({ id: davCards.id, body: davCards.body }).from(davCards).where(and(mine(userId), inArray(davCards.id, cards.map((card) => card.id))));
	const bodies = new Map(rows.map((row) => [row.id, row.body]));
	return cards.flatMap((card) => (bodies.has(card.id) ? [{ ...card, body: bodies.get(card.id) as string }] : []));
}

export type TextMatch = { value: string; matchType: "contains" | "equals" | "starts-with" | "ends-with"; negate: boolean; caseSensitive: boolean };
export type PropFilter = { name: "FN" | "EMAIL" | "UID"; matches: TextMatch[]; allOf: boolean; undefinedOnly: boolean };

function matches(candidates: string[], match: TextMatch): boolean {
	const fold = (text: string) => (match.caseSensitive ? text : text.toLowerCase());
	const needle = fold(match.value);
	const hit = candidates.some((candidate) => {
		const text = fold(candidate);
		return match.matchType === "equals" ? text === needle : match.matchType === "starts-with" ? text.startsWith(needle) : match.matchType === "ends-with" ? text.endsWith(needle) : text.includes(needle);
	});
	return match.negate ? !hit : hit;
}

/** Whether a card passes every prop-filter (`allOf`: all filters, else any one; a filter with several text-matches follows its own `allOf`). */
export function cardMatches(card: CardMeta, filters: PropFilter[], allOf: boolean): boolean {
	if (!filters.length) return true;
	const test = (filter: PropFilter) => {
		const values = filter.name === "FN" ? [card.fn].filter(Boolean) : filter.name === "UID" ? [card.uid] : card.emails;
		if (filter.undefinedOnly) return values.length === 0;
		if (!filter.matches.length) return values.length > 0;
		return filter.allOf ? filter.matches.every((match) => matches(values, match)) : filter.matches.some((match) => matches(values, match));
	};
	return allOf ? filters.every(test) : filters.some(test);
}

/** Id, name and update time of the cards that still exist among some card ids, for sync-collection. */
export async function liveCardNames(env: Env, userId: string, ids: string[]): Promise<Map<string, { name: string; updatedAt: Date }>> {
	const live = new Map<string, { name: string; updatedAt: Date }>();
	for (let i = 0; i < ids.length; i += CARD_CHUNK) {
		const rows = await getDb(env).select({ id: davCards.id, name: davCards.name, updatedAt: davCards.updatedAt }).from(davCards).where(and(mine(userId), inArray(davCards.id, ids.slice(i, i + CARD_CHUNK))));
		for (const row of rows) live.set(row.id, { name: row.name, updatedAt: row.updatedAt });
	}
	return live;
}
