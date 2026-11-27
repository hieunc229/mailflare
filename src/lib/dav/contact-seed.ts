import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, davCards, davCollections } from "@/db/schema";
import { containsLike } from "@/db/sql";
import { isMissingColumnError, isMissingTableError, isUniqueConstraintError } from "@/lib/database-errors";
import { isDavAddress } from "./address";
import { buildCard } from "./card-edit";
import { parseCard } from "./card-parse";
import { cardUsage, MAX_CARDS } from "./card-store";
import { addressBookCollectionId } from "./changes";
import { ownAddresses } from "./contact-mirror";
import { isDavEnabled } from "./settings";
import { MAX_CARD_BYTES } from "./writes";

/**
 * Seeding (spec 8.4): a user's manual contacts become cards, so turning CalDAV/CardDAV on brings the existing ones along.
 * Bounded and resumable: a step is one chunk of SEED_CHUNK contacts (a handful of statements). It only moves forward:
 * `dav_collections.seed_cursor` is the last contact id dealt with, so a card the user deletes on a phone is not made again,
 * and only contacts created before `seed_started_at` are taken (a contact created later gets its card from the Contacts API
 * hooks). A contact is skipped, not retried, when its address cannot be on a card, is one of the owner's own addresses, is
 * already on some card, or its card UID is taken. A read request of a user (PROPFIND, REPORT, GET) does one step; the 5-minute
 * cron does one step for one address book per run, until `dav_collections.seeded_at` is set. Cards and the cursor are written
 * in one batch, so a step that fails writes nothing and is simply run again.
 */

/** Contacts per step: 3 inserts of 8 cards (12 parameters each) and one linking update of 3 x 24 + 2 parameters. */
export const SEED_CHUNK = 24;
const ROWS_PER_INSERT = 8;
const KNOWN_SEEDED_MAX = 10_000;

/** Users whose address book is known to be seeded (in this isolate), so a request does not read the flag again. */
const knownSeeded = new Set<string>();

/** Forget which address books are known to be seeded (tests). */
export const clearSeedingCache = () => knownSeeded.clear();

const hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

type Book = { seededAt: Date | null; seedStartedAt: Date | null; seedCursor: string | null };
const bookColumns = { seededAt: davCollections.seededAt, seedStartedAt: davCollections.seedStartedAt, seedCursor: davCollections.seedCursor };

const wholeSecond = () => new Date(Math.floor(Date.now() / 1000) * 1000);

/** The user's address book row, made when missing, with the start of seeding recorded. */
async function loadBook(env: CloudflareEnv, userId: string): Promise<Book> {
	const db = getDb(env);
	const id = addressBookCollectionId(userId);
	const read = async () => (await db.select(bookColumns).from(davCollections).where(eq(davCollections.id, id)).limit(1))[0];
	let row = await read();
	if (!row) {
		await db.insert(davCollections).values({ id, userId, kind: "addressbook", seedStartedAt: wholeSecond() }).onConflictDoNothing();
		row = await read();
	}
	if (row && !row.seededAt && !row.seedStartedAt) {
		await db.update(davCollections).set({ seedStartedAt: wholeSecond() }).where(and(eq(davCollections.id, id), isNull(davCollections.seedStartedAt)));
		row = await read();
	}
	if (!row) throw new Error("The address book row is missing");
	return row;
}

/** Back of the cron's queue: a book whose step failed must not be the one it takes again at once. */
const touch = (env: CloudflareEnv, userId: string) => getDb(env).update(davCollections).set({ updatedAt: wholeSecond() }).where(and(eq(davCollections.id, addressBookCollectionId(userId)), isNull(davCollections.seededAt)));

/** One chunk of contacts into cards, one attempt. "more" when the address book is not seeded yet (also when a concurrent writer won: the next step starts from a fresh read). */
async function seedChunk(env: CloudflareEnv, userId: string, book: Book): Promise<"more" | "done"> {
	const db = getDb(env);
	const collectionId = addressBookCollectionId(userId);
	const now = wholeSecond();
	const bookUpdate = (cursor: string | null, done: boolean) =>
		db.update(davCollections).set({ seedCursor: cursor, updatedAt: now, ...(done ? { seededAt: now } : {}) }).where(and(eq(davCollections.id, collectionId), isNull(davCollections.seededAt)));

	const rows = await db
		.select({ id: contacts.id, email: contacts.email, displayName: contacts.displayName })
		.from(contacts)
		.where(and(eq(contacts.userId, userId), eq(contacts.source, "manual"), isNull(contacts.davCardId), lte(contacts.createdAt, book.seedStartedAt ?? wholeSecond()), book.seedCursor ? gt(contacts.id, book.seedCursor) : undefined))
		.orderBy(asc(contacts.id))
		.limit(SEED_CHUNK);
	if (!rows.length) {
		await bookUpdate(book.seedCursor, true);
		return "done";
	}

	// The cards these contacts would get, and what is already there: the owner's own addresses, addresses on some card, taken UIDs.
	const keyed = await Promise.all(rows.filter((row) => isDavAddress(row.email)).map(async (row) => ({ ...row, key: (await hex(row.id)).slice(0, 32) })));
	const own = keyed.length ? await ownAddresses(env, userId, keyed.map((row) => row.email)) : new Set<string>();
	const there = keyed.length
		? await db
				.select({ uid: davCards.uid, emails: davCards.emails })
				.from(davCards)
				.where(and(eq(davCards.userId, userId), eq(davCards.collectionId, collectionId), or(inArray(davCards.uid, keyed.map((row) => `mf-${row.key}`)), ...keyed.map((row) => containsLike(davCards.emails, JSON.stringify(row.email))))))
		: [];
	const listed = new Set(there.flatMap((card) => JSON.parse(card.emails) as string[]));
	const uids = new Set(there.map((card) => card.uid));
	const usage = keyed.length ? await cardUsage(env, userId) : { count: 0, bytes: 0 };

	const built: Array<{ contactId: string; row: typeof davCards.$inferInsert }> = [];
	let bytes = usage.bytes;
	let through: string | null = book.seedCursor;
	let paused = false;
	for (const row of rows) {
		const contact = keyed.find((candidate) => candidate.id === row.id);
		const uid = contact && `mf-${contact.key}`;
		if (contact && uid && !own.has(contact.email) && !listed.has(contact.email) && !uids.has(uid)) {
			const body = buildCard({ uid, name: contact.displayName, email: contact.email });
			const parsed = parseCard(body);
			const size = new TextEncoder().encode(body).byteLength;
			if (!("error" in parsed)) {
				// The limits pause seeding here; it goes on from this contact when there is room.
				if (usage.count + built.length >= MAX_CARDS || bytes + size > MAX_CARD_BYTES) {
					paused = true;
					break;
				}
				bytes += size;
				built.push({ contactId: contact.id, row: { id: `card_${contact.key}`, userId, collectionId, name: `${uid}.vcf`, uid, body, version: parsed.version, fn: parsed.fn, emails: JSON.stringify(parsed.emails), size, createdAt: now, updatedAt: now } });
			}
		}
		through = row.id;
	}
	if (paused) console.warn("The address book is full; seeding continues when there is room");
	const done = !paused && rows.length < SEED_CHUNK;
	const statements: unknown[] = [];
	for (let i = 0; i < built.length; i += ROWS_PER_INSERT) statements.push(db.insert(davCards).values(built.slice(i, i + ROWS_PER_INSERT).map((card) => card.row)));
	if (built.length) {
		statements.push(
			db
				.update(contacts)
				.set({ davCardId: sql`case ${contacts.id} ${sql.join(built.map((card) => sql`when ${card.contactId} then ${card.row.id}`), sql` `)} end` })
				.where(and(eq(contacts.userId, userId), eq(contacts.source, "manual"), isNull(contacts.davCardId), inArray(contacts.id, built.map((card) => card.contactId)))),
		);
	}
	// Written even when nothing moved (a full address book): the book goes to the back of the cron's queue.
	statements.push(bookUpdate(through, done));
	try {
		await db.batch(statements as never);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			await touch(env, userId);
			return "more";
		}
		throw error;
	}
	return done ? "done" : "more";
}

/**
 * One bounded step, one attempt. Cards are named after their contacts (so two seeders at once collide on the unique UID, the
 * loser writes nothing and its next step starts from a fresh read); a contact whose UID is taken for another reason is skipped.
 * `book` is the row when the caller already has it.
 */
export async function seedStep(env: CloudflareEnv, userId: string, book?: Book): Promise<"more" | "done"> {
	const current = book?.seedStartedAt ? book : await loadBook(env, userId);
	if (current.seededAt) {
		knownSeeded.add(userId);
		return "done";
	}
	const result = await seedChunk(env, userId, current);
	if (result === "done") knownSeeded.add(userId);
	return result;
}

/**
 * A read request of a user (PROPFIND, REPORT, GET on the address book) does one seeding step (a small address book is
 * complete right away); the cron does the rest. Once a user is known to be seeded this costs nothing. Never throws: an
 * address book that cannot be seeded now is served as it is.
 */
export async function ensureSeeded(env: CloudflareEnv, userId: string): Promise<void> {
	if (knownSeeded.has(userId)) return;
	try {
		const book = await loadBook(env, userId);
		if (book.seededAt) {
			if (knownSeeded.size >= KNOWN_SEEDED_MAX) knownSeeded.clear();
			knownSeeded.add(userId);
			return;
		}
		await seedStep(env, userId, book);
	} catch (error) {
		if (!isMissingColumnError(error) && !isMissingTableError(error)) console.warn("Could not seed the address book", error);
	}
}

/**
 * Cron: one seeding step for one unfinished address book per run (24 contacts, about a dozen statements), the one that has
 * waited longest. Does nothing while the switch is off. Returns the steps taken.
 */
export async function runContactSeeding(env: CloudflareEnv): Promise<number> {
	try {
		if (!(await isDavEnabled(env))) return 0;
		const [pending] = await getDb(env).select({ userId: davCollections.userId, ...bookColumns }).from(davCollections).where(and(eq(davCollections.kind, "addressbook"), isNull(davCollections.seededAt))).orderBy(asc(davCollections.updatedAt)).limit(1);
		if (!pending) return 0;
		try {
			await seedStep(env, pending.userId, pending);
		} catch (error) {
			await touch(env, pending.userId).catch(() => undefined);
			throw error;
		}
		return 1;
	} catch (error) {
		// Migration 0105 (or the DAV tables) is applied later from Admin settings on some installations.
		if (isMissingColumnError(error) || isMissingTableError(error)) return 0;
		throw error;
	}
}
