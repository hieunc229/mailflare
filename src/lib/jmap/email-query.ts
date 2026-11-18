import { and, asc, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, ne, not, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messageAttachments, messages } from "@/db/schema";
import { concatText, containsLike, escapeLike, insensitiveLike as like, matchEverything, matchNothing } from "@/db/sql";
import { KEYWORD_DRAFT, KEYWORD_FLAGGED, KEYWORD_SEEN } from "./constants";
import { invalidArguments, unsupportedFilter } from "./errors";
import { normalizeMessageId } from "@/lib/email/threading";
import { decodeMailboxRef, roleToStatus } from "./ids";
import type { Comparator, Filter, FilterCondition, MailboxRef } from "./types";

/** The SQL predicate for "is in this JMAP Mailbox". */
export function mailboxRefCondition(ref: MailboxRef): SQL {
	const base = eq(messages.mailboxId, ref.mailboxId);
	if (ref.kind === "account") return base;
	if (ref.kind === "folder") return and(base, eq(messages.folderId, ref.folderId))!;
	const status = roleToStatus(ref.role);
	if (ref.role === "inbox") return and(base, eq(messages.status, status), isNull(messages.folderId))!;
	if (ref.role === "sent") return and(base, inArray(messages.status, ["sent", "queued", "failed"]), isNull(messages.folderId))!;
	return and(base, eq(messages.status, status), isNull(messages.folderId))!;
}

function keywordCondition(keyword: string, present: boolean): SQL {
	switch (keyword) {
		case KEYWORD_SEEN:
			return present ? or(eq(messages.read, true), eq(messages.direction, "outbound"))! : and(eq(messages.read, false), eq(messages.direction, "inbound"))!;
		case KEYWORD_FLAGGED:
			return eq(messages.starred, present);
		case KEYWORD_DRAFT:
			return present ? eq(messages.status, "draft") : ne(messages.status, "draft");
		default:
			// Unknown keywords are never set, so "has" matches nothing and "not" matches all.
			return present ? matchNothing : matchEverything;
	}
}

/**
 * RFC 8621 §4.4.1 `header`: `[name]` means the header is present, `[name, value]`
 * that its value equals that string. Only the headers Mailflare keeps as columns
 * can be matched, and Message-IDs compare without their angle brackets because
 * inbound rows store them with and outbound rows without.
 */
function headerCondition(header: string[]): SQL {
	if (!Array.isArray(header) || header.length < 1 || header.length > 2 || typeof header[0] !== "string") {
		throw invalidArguments("header must be [name] or [name, value]");
	}
	const name = header[0].trim().toLowerCase();
	const value = header.length === 2 ? normalizeMessageId(String(header[1])) : null;
	switch (name) {
		case "message-id":
			if (header.length === 1) return isNotNull(messages.providerMessageId);
			return value ? inArray(messages.providerMessageId, [value, `<${value}>`]) : matchNothing;
		case "in-reply-to":
			if (header.length === 1) return isNotNull(messages.inReplyTo);
			return value ? inArray(messages.inReplyTo, [value, `<${value}>`]) : matchNothing;
		case "references":
			if (header.length === 1) return isNotNull(messages.references);
			// The column is the space-joined chain, so pad both sides to match whole ids only.
			return value ? like(concatText(' ', sql`coalesce(${messages.references}, '')`, ' '), `% ${escapeLike(value)} %`) : matchNothing;
		default:
			throw unsupportedFilter(`Cannot filter on the ${header[0]} header`);
	}
}

function conditionToSql(condition: FilterCondition, accessible: Set<string>): SQL[] {
	const parts: SQL[] = [];
	if (condition.inMailbox !== undefined) {
		const ref = decodeMailboxRef(condition.inMailbox);
		if (!ref || !accessible.has(ref.mailboxId)) throw invalidArguments(`Unknown mailbox ${condition.inMailbox}`);
		parts.push(mailboxRefCondition(ref));
	}
	if (condition.inMailboxOtherThan) {
		for (const id of condition.inMailboxOtherThan) {
			const ref = decodeMailboxRef(id);
			if (ref && accessible.has(ref.mailboxId)) parts.push(not(mailboxRefCondition(ref)));
		}
	}
	if (condition.before) parts.push(lt(messages.createdAt, new Date(condition.before)));
	if (condition.after) parts.push(gte(messages.createdAt, new Date(condition.after)));
	if (condition.hasKeyword) parts.push(keywordCondition(condition.hasKeyword, true));
	if (condition.notKeyword) parts.push(keywordCondition(condition.notKeyword, false));
	if (condition.someInThreadHaveKeyword) parts.push(keywordCondition(condition.someInThreadHaveKeyword, true));
	if (condition.allInThreadHaveKeyword) parts.push(keywordCondition(condition.allInThreadHaveKeyword, true));
	if (condition.noneInThreadHaveKeyword) parts.push(keywordCondition(condition.noneInThreadHaveKeyword, false));
	if (condition.from) parts.push(containsLike(messages.fromAddr, condition.from));
	if (condition.to) parts.push(containsLike(messages.toAddr, condition.to));
	if (condition.cc) parts.push(containsLike(messages.ccAddr, condition.cc));
	if (condition.bcc) parts.push(containsLike(messages.bccAddr, condition.bcc));
	if (condition.subject) parts.push(containsLike(messages.subject, condition.subject));
	if (condition.body) parts.push(or(containsLike(messages.textBody, condition.body), containsLike(messages.htmlBody, condition.body))!);
	if (condition.text) {
		const pattern = `%${escapeLike(condition.text)}%`;
		parts.push(
			or(
				like(messages.subject, pattern),
				like(messages.fromAddr, pattern),
				like(messages.toAddr, pattern),
				like(messages.ccAddr, pattern),
				like(messages.textBody, pattern),
				like(messages.snippet, pattern),
			)!,
		);
	}
	if (condition.header) parts.push(headerCondition(condition.header));
	if (condition.hasAttachment !== undefined) {
		const hasOne = exists(
			sql`(SELECT 1 FROM ${messageAttachments} WHERE ${messageAttachments.messageId} = ${messages.id} AND ${messageAttachments.disposition} = 'attachment')`,
		);
		parts.push(condition.hasAttachment ? hasOne : not(hasOne));
	}
	if (condition.minSize !== undefined) parts.push(gte(sql`length(coalesce(${messages.textBody}, '')) + length(coalesce(${messages.htmlBody}, ''))`, condition.minSize));
	if (condition.maxSize !== undefined) parts.push(lt(sql`length(coalesce(${messages.textBody}, '')) + length(coalesce(${messages.htmlBody}, ''))`, condition.maxSize));
	return parts;
}

/** FilterOperator trees become nested AND/OR/NOT; a bare condition is an AND of its fields. */
export function filterToSql(filter: Filter | null | undefined, accessible: Set<string>): SQL | undefined {
	if (!filter) return undefined;
	if ("operator" in filter) {
		const children = (filter.conditions ?? []).map((child) => filterToSql(child, accessible)).filter((part): part is SQL => !!part);
		if (children.length === 0) return undefined;
		if (filter.operator === "AND") return and(...children);
		if (filter.operator === "OR") return or(...children);
		if (filter.operator === "NOT") return not(and(...children)!);
		throw invalidArguments(`Unknown operator ${String(filter.operator)}`);
	}
	const parts = conditionToSql(filter, accessible);
	return parts.length ? and(...parts) : undefined;
}

export function sortToSql(sort: Comparator[] | null | undefined): SQL[] {
	const comparators = sort && sort.length ? sort : [{ property: "receivedAt", isAscending: false }];
	return comparators.map((item) => {
		const direction = item.isAscending ? asc : desc;
		switch (item.property) {
			case "receivedAt":
			case "sentAt":
				return direction(messages.createdAt);
			case "subject":
				return direction(messages.subject);
			case "from":
				return direction(messages.fromAddr);
			case "to":
				return direction(messages.toAddr);
			case "size":
				return direction(sql`length(coalesce(${messages.textBody}, '')) + length(coalesce(${messages.htmlBody}, ''))`);
			case "hasKeyword":
			case "allInThreadHaveKeyword":
			case "someInThreadHaveKeyword": {
				const keyword = (item as Comparator & { keyword?: string }).keyword ?? KEYWORD_SEEN;
				return direction(keyword === KEYWORD_FLAGGED ? messages.starred : messages.read);
			}
			default:
				throw invalidArguments(`Cannot sort by ${item.property}`);
		}
	});
}

export { gt };
