import { and, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import { mailboxPromotionSettings, messages } from "@/db/schema";
import { matchNothing } from "@/db/sql";
import { isMissingTableError } from "@/lib/database-errors";

type Db = ReturnType<typeof getDb>;
export type PromotionMode = "off" | "show" | "separate";

/** Modes of the mailboxes that have a settings row. A mailbox without a row is `off`, and so is every mailbox before the migration. */
export async function loadPromotionModes(db: Db, mailboxIds: string[]): Promise<Map<string, PromotionMode>> {
	if (mailboxIds.length === 0) return new Map();
	try {
		const rows = await db.select({ mailboxId: mailboxPromotionSettings.mailboxId, mode: mailboxPromotionSettings.mode })
			.from(mailboxPromotionSettings)
			.where(inArray(mailboxPromotionSettings.mailboxId, mailboxIds));
		return new Map(rows.map((row) => [row.mailboxId, row.mode]));
	} catch (error) {
		if (isMissingTableError(error)) return new Map();
		throw error;
	}
}

/**
 * Inbox rows, minus promotions in the given `separate` mailboxes. `undefined` when no mailbox hides them.
 * `otherIds` are the remaining mailboxes in scope; the shorter of the two lists is bound, because D1 allows 100 parameters per query.
 */
export function inboxVisibleCondition(separateIds: string[], otherIds: string[]): SQL | undefined {
	if (separateIds.length === 0) return undefined;
	const inScope = separateIds.length <= otherIds.length ? notInArray(messages.mailboxId, separateIds) : inArray(messages.mailboxId, otherIds);
	return or(isNull(messages.category), ne(messages.category, "promotions"), inScope);
}

/** Promotions rows of the given mailboxes (those whose mode is not off). Matches nothing when all of them are off. The shorter list is bound. */
export function promotionsVisibleCondition(onIds: string[], offIds: string[]): SQL {
	if (onIds.length === 0) return matchNothing;
	const inScope = onIds.length <= offIds.length ? inArray(messages.mailboxId, onIds) : notInArray(messages.mailboxId, offIds);
	return and(eq(messages.category, "promotions"), inScope)!;
}

/**
 * The category predicate of a received-mail list, shared by the list route and reader navigation so both always agree:
 * `promotions` lists the promotions of mailboxes whose mode is not off, `inbox` hides the promotions of `separate`
 * mailboxes (undefined when none is). `scope` is the mailboxes the request can see.
 */
export async function categoryScopeCondition(db: Db, scope: string[], view: "promotions" | "inbox"): Promise<SQL | undefined> {
	const modes = await loadPromotionModes(db, scope);
	if (view === "promotions") return promotionsVisibleCondition(scope.filter((id) => (modes.get(id) ?? "off") !== "off"), scope.filter((id) => (modes.get(id) ?? "off") === "off"));
	return inboxVisibleCondition(scope.filter((id) => modes.get(id) === "separate"), scope.filter((id) => modes.get(id) !== "separate"));
}
