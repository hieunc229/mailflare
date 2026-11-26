import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { davCollections, users } from "@/db/schema";
import { validTimeZone } from "@/lib/calendar/feed";
import { calendarTimezoneObject, renderCalendarObject, resourceUpdatedAt, type CalendarResource } from "./calendar-render";
import { countCalendar, LIST_PAGE, MAX_LISTED, pageCalendar } from "./calendar-store";
import type { CalendarCollection, CalendarListing } from "./calendar-collections";
import { roleAtLeast } from "@/lib/calendar/shares";
import { defaultScope } from "./calendar-scope";
import { etagFromSeq, formatSyncToken, syncPosition, addressBookCollectionId } from "./changes";
import { collection, el, href, NS, precondition, selectProps, streamMultistatus, XML_HEADERS, type ListedRow, type Property } from "./common";
import { countCards, pageCards, type CardMeta, type Card } from "./card-store";
import type { DavElement } from "./xml";
import { escapeXml, multistatus, type DavResponse } from "./xml-writer";

export type Area = "calendars" | "addressbooks";
/** `userId` is the requesting user; `calendar` the calendar collection the path names (absent: their default calendar). */
export type DavContext = { env: CloudflareEnv; userId: string; email: string; name: string; timeZone: string | null; origin: string; calendar?: CalendarCollection };

/** The calendar a context serves: the collection its path names, else the user's default calendar. */
export const calendarOf = (ctx: Pick<DavContext, "userId" | "calendar">): CalendarCollection => ctx.calendar ?? { ...defaultScope(ctx.userId), role: "owner", segment: "default", grantId: null };

export const collectionPath = (area: Area, userId: string, segment = "default") => `/dav/${area}/${userId}/${segment}/`;
/** The path of the collection a request is about. */
export const pathOf = (area: Area, ctx: Pick<DavContext, "userId" | "calendar">) => collectionPath(area, ctx.userId, area === "calendars" ? calendarOf(ctx).segment : "default");
export const collectionIdFor = (area: Area, ctx: Pick<DavContext, "userId" | "calendar">) => (area === "calendars" ? calendarOf(ctx).id : addressBookCollectionId(ctx.userId));

const RESOURCE_LIMIT = 1_048_576;
const REPORTS: Record<Area, string[]> = {
	calendars: [`<C:calendar-multiget/>`, `<C:calendar-query/>`, `<D:sync-collection/>`],
	addressbooks: [`<CR:addressbook-multiget/>`, `<CR:addressbook-query/>`, `<D:sync-collection/>`],
};
// PROPPATCH is not served, so write-properties is not claimed.
const PRIVILEGES = ["read", "write", "write-content", "bind", "unbind", "read-current-user-privilege-set"];
const READ_PRIVILEGES = ["read", "read-current-user-privilege-set"];

/** A resource as the report and PROPFIND code sees it: what the live properties need, with the body produced on demand. */
export type Member = { name: string; etag: string; lastModified: Date; contentType: string; /** Known without the body (a stored card), so the length is cheap. */ size?: number; body?: () => string };

export const etagOf = (seqs: Map<string, number>, key: string, updatedAt: Date) => etagFromSeq(seqs.get(key), updatedAt);

const once = <T>(make: () => T): (() => T) => {
	let value: T | undefined;
	let made = false;
	return () => {
		if (!made) {
			value = make();
			made = true;
		}
		return value as T;
	};
};

export function calendarMember(resource: CalendarResource, seqs: Map<string, number>, userZone?: string | null): Member {
	const updatedAt = resourceUpdatedAt(resource);
	return { name: resource.name, etag: etagOf(seqs, resource.id, updatedAt), lastModified: updatedAt, contentType: "text/calendar; charset=utf-8", body: once(() => renderCalendarObject(resource, userZone)) };
}

export function cardMember(card: CardMeta | Card, seqs: Map<string, number>): Member {
	return { name: card.name, etag: etagOf(seqs, card.id, card.updatedAt), lastModified: card.updatedAt, contentType: "text/vcard; charset=utf-8", size: card.size, body: "body" in card ? () => card.body : undefined };
}

/** Live properties of one resource. Without a `body` the data and length properties are not offered (404 propstat). */
export function memberProperties(area: Area, member: Member): Property[] {
	const props: Property[] = [
		{ ns: NS.dav, name: "getetag", value: () => el(NS.dav, "getetag", escapeXml(member.etag)) },
		{ ns: NS.dav, name: "getcontenttype", value: () => el(NS.dav, "getcontenttype", escapeXml(member.contentType)) },
		{ ns: NS.dav, name: "getlastmodified", value: () => el(NS.dav, "getlastmodified", member.lastModified.toUTCString()) },
		{ ns: NS.dav, name: "resourcetype", value: () => el(NS.dav, "resourcetype") },
	];
	const body = member.body;
	if (member.size !== undefined) props.push({ ns: NS.dav, name: "getcontentlength", value: () => el(NS.dav, "getcontentlength", String(member.size)) });
	else if (body) props.push({ ns: NS.dav, name: "getcontentlength", heavy: true, value: () => el(NS.dav, "getcontentlength", String(new TextEncoder().encode(body()).byteLength)) });
	if (body) {
		props.push(
			area === "calendars" ? { ns: NS.caldav, name: "calendar-data", heavy: true, value: () => el(NS.caldav, "calendar-data", escapeXml(body())) } : { ns: NS.carddav, name: "address-data", heavy: true, value: () => el(NS.carddav, "address-data", escapeXml(body())) },
		);
	}
	return props;
}

export const memberResponse = (area: Area, ctx: DavContext, member: Member, wanted: DavElement | undefined) => selectProps(wanted, { href: pathOf(area, ctx) + member.name, props: memberProperties(area, member) });

/** Read-only for a `read` grant, what F6 serves for everyone who may write (D-12). */
const privilegeSet = (writable: boolean) => el(NS.dav, "current-user-privilege-set", (writable ? PRIVILEGES : READ_PRIVILEGES).map((name) => `<D:privilege><D:${name}/></D:privilege>`).join(""));

/** What a home listing has read already: the collection's own properties and, for the whole home at once, the sync positions. */
export type CollectionPreload = { listing?: CalendarListing; positions?: Map<string, { epoch: string; seq: number }> };

/** Live properties of the calendar or address book collection. The expensive ones (stored settings, sync position) are read once and only when asked for. */
export function collectionProperties(area: Area, ctx: DavContext, preload: CollectionPreload = {}): Property[] {
	const cid = collectionIdFor(area, ctx);
	const calendarRole = area === "calendars" ? calendarOf(ctx) : null;
	const shared = !!calendarRole && calendarRole.ownerId !== ctx.userId;
	const settings = once(async () => preload.listing ?? (await getDb(ctx.env).select().from(davCollections).where(eq(davCollections.id, cid)).limit(1))[0]);
	const token = once(async () => {
		// The epoch is read first so a fresh collection gets its state row before the position is taken.
		const { epoch, seq } = preload.positions?.get(cid) ?? (await syncPosition(ctx.env, cid));
		return formatSyncToken(ctx.origin, cid, epoch, seq);
	});
	// A shared calendar is told apart from the user's own by its owner's name; the owner's principal is not one this server serves, so `owner` stays the user's own.
	const calendarName = async () => {
		const base = (await settings())?.displayName || "Mailflare";
		if (!shared) return base;
		const [owner] = preload.listing ? [{ name: preload.listing.ownerName }] : await getDb(ctx.env).select({ name: sql<string>`coalesce(nullif(${users.name}, ''), ${users.email})` }).from(users).where(eq(users.id, calendarRole!.ownerId)).limit(1);
		return owner?.name ? `${base} (${owner.name})` : base;
	};
	const principal = `/dav/principals/${ctx.userId}/`;
	const calendar = area === "calendars";
	const props: Property[] = [
		{ ns: NS.dav, name: "resourcetype", value: () => collection(calendar ? el(NS.caldav, "calendar") : el(NS.carddav, "addressbook")) },
		{ ns: NS.dav, name: "displayname", value: async () => el(NS.dav, "displayname", escapeXml(calendar ? await calendarName() : (await settings())?.displayName || "Contacts")) },
		{ ns: NS.dav, name: "owner", value: () => el(NS.dav, "owner", href(principal)) },
		{ ns: NS.dav, name: "current-user-principal", value: () => el(NS.dav, "current-user-principal", href(principal)) },
		{ ns: NS.dav, name: "current-user-privilege-set", value: () => privilegeSet(!calendarRole || roleAtLeast(calendarRole.role, "edit")) },
		{ ns: NS.dav, name: "supported-report-set", value: () => el(NS.dav, "supported-report-set", REPORTS[area].map((report) => `<D:supported-report><D:report>${report}</D:report></D:supported-report>`).join("")) },
		{ ns: NS.dav, name: "sync-token", value: async () => el(NS.dav, "sync-token", escapeXml(await token())) },
		{ ns: NS.cs, name: "getctag", value: async () => el(NS.cs, "getctag", escapeXml(await token())) },
	];
	if (calendar) {
		props.push(
			{ ns: NS.caldav, name: "supported-calendar-component-set", value: () => el(NS.caldav, "supported-calendar-component-set", `<C:comp name="VEVENT"/>`) },
			{ ns: NS.caldav, name: "supported-calendar-data", value: () => el(NS.caldav, "supported-calendar-data", `<C:calendar-data content-type="text/calendar" version="2.0"/>`) },
			{ ns: NS.caldav, name: "max-resource-size", value: () => el(NS.caldav, "max-resource-size", String(RESOURCE_LIMIT)) },
			{ ns: NS.caldav, name: "min-date-time", value: () => el(NS.caldav, "min-date-time", "19000101T000000Z") },
			{ ns: NS.caldav, name: "max-date-time", value: () => el(NS.caldav, "max-date-time", "22000101T000000Z") },
			{ ns: NS.caldav, name: "max-instances", value: () => el(NS.caldav, "max-instances", "2000") },
			{ ns: NS.caldav, name: "max-attendees-per-instance", value: () => el(NS.caldav, "max-attendees-per-instance", "100") },
			{ ns: NS.caldav, name: "calendar-timezone", value: () => el(NS.caldav, "calendar-timezone", escapeXml(calendarTimezoneObject(validTimeZone(ctx.timeZone) ?? "UTC"))) },
			{ ns: NS.caldav, name: "calendar-description", value: async () => el(NS.caldav, "calendar-description", escapeXml((await settings())?.description ?? "")) },
			{ ns: NS.apple, name: "calendar-color", value: async () => el(NS.apple, "calendar-color", escapeXml((await settings())?.color ?? "")) },
			{ ns: NS.apple, name: "calendar-order", value: async () => el(NS.apple, "calendar-order", String((await settings())?.sortOrder ?? 0)) },
		);
	} else {
		props.push(
			{ ns: NS.carddav, name: "supported-address-data", value: () => el(NS.carddav, "supported-address-data", `<CR:address-data-type content-type="text/vcard" version="3.0"/><CR:address-data-type content-type="text/vcard" version="4.0"/>`) },
			{ ns: NS.carddav, name: "max-resource-size", value: () => el(NS.carddav, "max-resource-size", String(RESOURCE_LIMIT)) },
			{ ns: NS.carddav, name: "addressbook-description", value: async () => el(NS.carddav, "addressbook-description", escapeXml((await settings())?.description ?? "")) },
		);
	}
	return props;
}

/**
 * The collection's members for PROPFIND depth 1 and the first sync, page by page with ETags (a statement per 1000
 * resources, so memory stays bounded). A body (needed only for `getcontentlength`) is not loaded; those properties are
 * answered 404 at depth 1. `"truncated"` above MAX_LISTED resources, counted up front so the answer can still be a 507.
 */
export async function listMembers(area: Area, ctx: DavContext): Promise<AsyncGenerator<Member[]> | "truncated"> {
	const calendar = area === "calendars";
	if ((await (calendar ? countCalendar(ctx.env, calendarOf(ctx)) : countCards(ctx.env, ctx.userId))) > MAX_LISTED) return "truncated";
	const pages = calendar ? pageCalendar(ctx.env, calendarOf(ctx)) : pageCards(ctx.env, ctx.userId, LIST_PAGE, MAX_LISTED);
	const contentType = calendar ? "text/calendar; charset=utf-8" : "text/vcard; charset=utf-8";
	return (async function* () {
		for await (const page of pages) yield page.map((row: ListedRow) => ({ name: row.name, etag: row.etag, lastModified: row.updatedAt, contentType, size: row.size }));
	})();
}

/** PROPFIND on the collection itself and, at depth 1, on every member, streamed. */
export async function propfindCollection(area: Area, ctx: DavContext, wanted: DavElement | undefined, depth: "0" | "1"): Promise<Response> {
	const path = pathOf(area, ctx);
	const self = await selectProps(wanted, { href: path, props: collectionProperties(area, ctx) });
	if (depth === "0") return new Response(multistatus([self]), { status: 207, headers: XML_HEADERS });
	const members = await listMembers(area, ctx);
	if (members === "truncated") return precondition(507, "number-of-matches-within-limits");
	async function* responses(): AsyncGenerator<DavResponse[]> {
		let first = true;
		for await (const page of members as AsyncGenerator<Member[]>) {
			const out = await Promise.all(page.map((member) => memberResponse(area, ctx, member, wanted)));
			yield first ? [self, ...out] : out;
			first = false;
		}
		if (first) yield [self];
	}
	return streamMultistatus(responses(), { href: path });
}
