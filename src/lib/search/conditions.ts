import { and, eq, exists, gte, lt, not, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { messageAttachments, messages } from "@/db/schema";
import { schemaDialect } from "@/db/dialect";
import { buildFtsMatch, parseSearchQuery, tokenizeSearchText } from "./query-utils";
import type { ParsedSearchQuery } from "./types";

/** `!` is the escape character because it needs no escaping itself in either SQL string syntax. */
const likePattern = (term: string) => `%${term.toLowerCase().replace(/[!%_]/g, "!$&")}%`;
/** A NULL column counts as empty text: otherwise `NOT (a OR b)` is NULL and a negated term hides the row. */
const contains = (column: SQL | AnyColumn, term: string) => sql`coalesce(lower(${column}), '') like ${likePattern(term)} escape '!'`;

/**
 * Text search for databases without FTS5 (PostgreSQL, MySQL): every term must appear as a substring of the
 * subject, an address or the body. It scans the mailbox's messages instead of using an index, which is the
 * documented trade-off of those dialects.
 */
function buildLikeConditions(parsed: ParsedSearchQuery): SQL[] {
	const conditions: SQL[] = [];
	for (const token of tokenizeSearchText(parsed.text)) {
		const match = or(
			contains(messages.subject, token.term),
			contains(messages.fromAddr, token.term),
			contains(messages.toAddr, token.term),
			contains(messages.ccAddr, token.term),
			contains(messages.textBody, token.term),
			and(sql`${messages.textBody} is null`, contains(messages.htmlBody, token.term)),
		)!;
		conditions.push(token.negate ? not(match) : match);
	}
	const column = (columns: Array<SQL | AnyColumn>, value: string | undefined) => {
		if (!value) return;
		for (const token of tokenizeSearchText(value)) conditions.push(or(...columns.map((c) => contains(c, token.term)))!);
	};
	column([messages.subject], parsed.subject);
	column([messages.fromAddr], parsed.from);
	column([messages.toAddr, messages.ccAddr], parsed.to);
	return conditions;
}

/**
 * Translate a search string into WHERE conditions on `messages`. Text goes to
 * the FTS5 index by rowid; everything else is a plain column predicate, so the
 * caller ANDs these with its own scope (mailbox access, folder, status).
 */
export function buildSearchConditions(raw: string, timeZone = "UTC"): SQL[] {
	const parsed = parseSearchQuery(raw, timeZone);
	const conditions: SQL[] = [];

	if (schemaDialect() === "sqlite") {
		const match = buildFtsMatch(parsed);
		if (match) {
			conditions.push(sql`${messages}.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match})`);
		}
	} else {
		conditions.push(...buildLikeConditions(parsed));
	}
	if (parsed.hasAttachment) {
		conditions.push(
			exists(
				sql`(SELECT 1 FROM ${messageAttachments} WHERE ${messageAttachments.messageId} = ${messages.id} AND ${messageAttachments.disposition} = 'attachment')`,
			),
		);
	}
	if (parsed.read === "read") conditions.push(eq(messages.read, true));
	if (parsed.read === "unread") conditions.push(eq(messages.read, false));
	if (parsed.starred) conditions.push(eq(messages.starred, true));
	if (parsed.after) conditions.push(gte(messages.createdAt, parsed.after));
	if (parsed.before) conditions.push(lt(messages.createdAt, parsed.before));

	return conditions.length ? [and(...conditions)!] : [];
}
