import { and } from "drizzle-orm";
import { CALENDAR_CHUNK, endedBefore, isDavMaster, listCalendar, liveCalendarNames, loadCalendarByNames, matchesUid, MAX_LISTED, MAX_QUERY_CANDIDATES, occursInRange, overlapsRange, withOverrides } from "./calendar-store";
import { cardMatches, CARD_CHUNK, listCards, liveCardNames, loadCardBodies, loadCardMetaByNames, MAX_CARDS, planCardChunks, type PropFilter, type TextMatch } from "./card-store";
import { changesSince, currentSeq, ensureSyncState, etagSeqs, formatSyncToken } from "./changes";
import { calendarMember, cardMember, collectionIdFor, collectionPath, etagOf, listMembers, memberResponse, type Area, type DavContext, type Member } from "./collections";
import { inChunks, NS, precondition, streamMultistatus, text, wantedProps } from "./common";
import type { DavElement } from "./xml";
import type { DavResponse } from "./xml-writer";
import { calendarCollectionId } from "./changes";
import type { CalendarResource } from "./calendar-render";

/** Hrefs one multiget may name; more is 403 `number-of-matches-within-limits`. */
export const MAX_MULTIGET_HREFS = 200;
/** Resources a query report returns; the rest is cut with a 507 for the collection (RFC 4791 section 9 / RFC 6578 section 3.6). */
export const MAX_REPORT_RESULTS = 1000;
/** Recurring events a single calendar-query may leave unresolved when the expansion budget ends; beyond this the request is refused. */
const MAX_EXHAUSTED = 25;
const MIN_DATE = Date.UTC(1900, 0, 1);
const MAX_DATE = Date.UTC(2200, 0, 1);
const MEMBER_NAME = /^[A-Za-z0-9._~@+=-]{1,200}$/;

const children = (element: DavElement, ns: string, name: string) => element.children.filter((child) => child.ns === ns && child.name === name);
const tooMany = () => precondition(403, "number-of-matches-within-limits");

/** The collection-relative resource name an href points at, or null for anything that is not a resource of this collection on this origin. */
export function memberNameFromHref(raw: string, area: Area, ctx: DavContext): string | null {
	const value = raw.trim();
	if (!value || value.length > 2048) return null;
	let url: URL;
	try {
		url = new URL(value, ctx.origin);
	} catch {
		return null;
	}
	const base = collectionPath(area, ctx.userId);
	if (url.origin !== ctx.origin || !url.pathname.startsWith(base)) return null;
	let name: string;
	try {
		name = decodeURIComponent(url.pathname.slice(base.length));
	} catch {
		return null;
	}
	return MEMBER_NAME.test(name) && name.endsWith(area === "calendars" ? ".ics" : ".vcf") ? name : null;
}

/** A `calendar-data` or `address-data` request this server cannot honour: expansion, recurrence limiting, another media type or version. */
function unsupportedData(wanted: DavElement | undefined, area: Area): boolean {
	const data = wanted?.children.find((child) => child.ns === (area === "calendars" ? NS.caldav : NS.carddav) && child.name === (area === "calendars" ? "calendar-data" : "address-data"));
	if (!data) return false;
	if (data.children.some((child) => ["expand", "limit-recurrence-set"].includes(child.name))) return true;
	const type = data.attrs["content-type"];
	const version = data.attrs.version;
	return area === "calendars" ? (!!type && type !== "text/calendar") || (!!version && version !== "2.0") : (!!type && !["text/vcard", "text/x-vcard"].includes(type));
}

const notFound = (area: Area, ctx: DavContext, name: string): DavResponse => ({ href: collectionPath(area, ctx.userId) + name, status: 404 });

/** `YYYYMMDDTHHMMSSZ` as an instant, or null. */
function utcValue(value: string | undefined): number | null {
	const match = value?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
	if (!match) return null;
	const at = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
	return Number.isNaN(at) || new Date(at).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z" !== value ? null : at;
}

type CalendarQuery = { comp: "VEVENT" | "other"; range: { start: number; end: number } | null; uid: string | null };

/** Only the filters clients use: VCALENDAR/VEVENT with a time-range or a UID text-match. Anything else is `null`: 403 `supported-filter`. `"invalid"`: 403 `valid-filter`. */
function parseCalendarFilter(root: DavElement): CalendarQuery | null | "invalid" {
	const filters = children(root, NS.caldav, "filter");
	if (filters.length !== 1) return "invalid";
	const top = filters[0].children;
	if (top.length !== 1 || top[0].ns !== NS.caldav || top[0].name !== "comp-filter" || top[0].attrs.name?.toUpperCase() !== "VCALENDAR") return null;
	const inner = top[0].children;
	if (!inner.length) return { comp: "VEVENT", range: null, uid: null };
	if (inner.length !== 1 || inner[0].ns !== NS.caldav || inner[0].name !== "comp-filter") return null;
	const event = inner[0];
	const name = event.attrs.name?.toUpperCase();
	if (name !== "VEVENT") return event.children.length ? null : { comp: "other", range: null, uid: null };
	const query: CalendarQuery = { comp: "VEVENT", range: null, uid: null };
	for (const part of event.children) {
		if (part.ns !== NS.caldav) return null;
		if (part.name === "time-range" && !query.range) {
			const start = part.attrs.start === undefined ? MIN_DATE : utcValue(part.attrs.start);
			const end = part.attrs.end === undefined ? MAX_DATE : utcValue(part.attrs.end);
			if (start === null || end === null || end <= start) return "invalid";
			query.range = { start: Math.max(start, MIN_DATE), end: Math.min(end, MAX_DATE) };
		} else if (part.name === "prop-filter" && !query.uid && part.attrs.name?.toUpperCase() === "UID" && part.children.length === 1 && part.children[0].ns === NS.caldav && part.children[0].name === "text-match" && !part.children[0].attrs["negate-condition"]) {
			query.uid = part.children[0].text.trim();
			if (!query.uid) return "invalid";
		} else return null;
	}
	return query;
}

function parseCardFilter(root: DavElement): { filters: PropFilter[]; allOf: boolean; limit: number | null } | null | "invalid" {
	const filter = children(root, NS.carddav, "filter");
	if (filter.length > 1) return "invalid";
	const filters: PropFilter[] = [];
	for (const prop of filter[0]?.children ?? []) {
		const name = prop.attrs.name?.toUpperCase();
		if (prop.ns !== NS.carddav || prop.name !== "prop-filter" || !(name === "FN" || name === "EMAIL" || name === "UID")) return null;
		const matches: TextMatch[] = [];
		let undefinedOnly = false;
		for (const part of prop.children) {
			if (part.ns !== NS.carddav) return null;
			if (part.name === "is-not-defined") undefinedOnly = true;
			else if (part.name === "text-match") {
				const matchType = part.attrs["match-type"] ?? "contains";
				const collation = part.attrs.collation ?? "i;unicode-casemap";
				if (!["contains", "equals", "starts-with", "ends-with"].includes(matchType) || !["i;unicode-casemap", "i;ascii-casemap", "i;octet"].includes(collation)) return null;
				matches.push({ value: part.text, matchType: matchType as TextMatch["matchType"], negate: part.attrs["negate-condition"] === "yes", caseSensitive: collation === "i;octet" });
			} else return null;
		}
		filters.push({ name, matches, allOf: prop.attrs.test === "allof", undefinedOnly });
	}
	const limit = children(root, NS.carddav, "limit")[0]?.children.find((child) => child.ns === NS.carddav && child.name === "nresults")?.text.trim();
	if (limit !== undefined && !/^[0-9]{1,6}$/.test(limit)) return "invalid";
	return { filters, allOf: filter[0]?.attrs.test === "allof", limit: limit === undefined ? null : Number(limit) };
}

const invalidFilter = (area: Area) => precondition(403, "valid-filter", area === "calendars" ? "C" : "CR");
const unsupportedFilter = (area: Area) => precondition(403, "supported-filter", area === "calendars" ? "C" : "CR");

const wantsData = (wanted: DavElement | undefined, area: Area) => wanted?.name === "prop" && wanted.children.some((child) => child.ns === (area === "calendars" ? NS.caldav : NS.carddav) && child.name === (area === "calendars" ? "calendar-data" : "address-data"));

/** Wrap members already in memory as response chunks of 90, rendering each only when its turn comes. */
async function* respond(area: Area, ctx: DavContext, members: Member[], wanted: DavElement | undefined): AsyncGenerator<DavResponse[]> {
	yield* inChunks(members, 90, (chunk) => Promise.all(chunk.map((member) => memberResponse(area, ctx, member, wanted))));
}

async function multiget(area: Area, ctx: DavContext, root: DavElement, wanted: DavElement | undefined): Promise<Response> {
	const hrefs = children(root, NS.dav, "href");
	if (hrefs.length > MAX_MULTIGET_HREFS) return tooMany();
	const names = new Set<string>();
	const invalid: string[] = [];
	for (const element of hrefs) {
		const name = memberNameFromHref(element.text, area, ctx);
		if (name) names.add(name);
		else invalid.push(element.text.trim());
	}
	const requested = [...names];
	const found = new Set<string>();
	async function* chunks(): AsyncGenerator<DavResponse[]> {
		const size = area === "calendars" ? CALENDAR_CHUNK : CARD_CHUNK;
		if (!requested.length) yield [];
		for (let i = 0; i < requested.length; i += size) {
			const slice = requested.slice(i, i + size);
			if (area === "calendars") {
				const resources = await loadCalendarByNames(ctx.env, ctx.userId, slice);
				const seqs = await etagSeqs(ctx.env, collectionIdFor(area, ctx.userId), resources.map((resource) => resource.id));
				yield await Promise.all(resources.map((resource) => (found.add(resource.name), memberResponse(area, ctx, calendarMember(resource, seqs, ctx.timeZone), wanted))));
			} else {
				const metas = await loadCardMetaByNames(ctx.env, ctx.userId, slice);
				const seqs = await etagSeqs(ctx.env, collectionIdFor(area, ctx.userId), metas.map((card) => card.id));
				const out: DavResponse[] = [];
				for (const plan of planCardChunks(metas)) for (const card of wantsData(wanted, area) ? await loadCardBodies(ctx.env, ctx.userId, plan) : plan) (found.add(card.name), out.push(await memberResponse(area, ctx, cardMember(card, seqs), wanted)));
				yield out;
			}
		}
	}
	// Hrefs that are not this user's resources, are not there or are hidden all look the same: a 404 of their own.
	const trailer = () => [...requested.filter((name) => !found.has(name)).map((name) => notFound(area, ctx, name)), ...invalid.map((href): DavResponse => ({ href, status: 404 }))];
	return streamMultistatus(chunks(), { href: collectionPath(area, ctx.userId), trailer });
}

async function calendarQuery(ctx: DavContext, root: DavElement, wanted: DavElement | undefined): Promise<Response> {
	const area = "calendars";
	const query = parseCalendarFilter(root);
	if (query === "invalid") return invalidFilter(area);
	if (!query) return unsupportedFilter(area);
	const href = collectionPath(area, ctx.userId);
	if (query.comp === "other") return streamMultistatus(respond(area, ctx, [], wanted), { href });
	const range = query.range ? { start: new Date(query.range.start), end: new Date(query.range.end) } : null;
	const where = and(range ? overlapsRange(range.start, range.end) : undefined, query.uid ? matchesUid(query.uid) : undefined);
	// Candidates in id order, a page at a time. A series that ended before the range cannot match and is skipped
	// without counting; scanning stops at MAX_LISTED rows, like the cap on the candidates themselves.
	const rows: CalendarResource[] = [];
	let truncated = false;
	for (let after: string | undefined, scanned = 0; ; ) {
		const page = await listCalendar(ctx.env, ctx.userId, MAX_QUERY_CANDIDATES, where, after);
		const cut = page.length > MAX_QUERY_CANDIDATES;
		const taken = cut ? page.slice(0, MAX_QUERY_CANDIDATES) : page;
		scanned += taken.length;
		rows.push(...(range ? taken.filter((resource) => !endedBefore(resource, range.start)) : taken));
		if (rows.length > MAX_QUERY_CANDIDATES || (cut && scanned >= MAX_LISTED)) {
			truncated = true;
			break;
		}
		if (!cut) break;
		after = taken[taken.length - 1].id;
	}
	const candidates = (query.uid ? rows.filter((resource) => resource.uid === query.uid) : rows).slice(0, MAX_QUERY_CANDIDATES);
	// Override rows are loaded only where they matter: a DAV series the master alone does not put in range (an override
	// may), and below, the series that are returned (their data needs them).
	const loaded = new Set<string>();
	let verdicts = range ? candidates.map((resource) => occursInRange(resource, range.start, range.end)) : [];
	if (range) {
		const undecided = candidates.filter((resource, i) => !verdicts[i].match && !verdicts[i].exhausted && isDavMaster(resource));
		await withOverrides(ctx.env, ctx.userId, undecided);
		for (const resource of undecided) loaded.add(resource.id);
		verdicts = candidates.map((resource, i) => (loaded.has(resource.id) ? occursInRange(resource, range.start, range.end) : verdicts[i]));
	}
	let exhausted = 0;
	const matched: CalendarResource[] = [];
	for (const [i, resource] of candidates.entries()) {
		if (range) {
			const result = verdicts[i];
			// A rule whose expansion ran out of budget may have an occurrence in range: it is returned, and the client filters.
			if (result.exhausted && ++exhausted > MAX_EXHAUSTED) return tooMany();
			if (!result.match && !result.exhausted) continue;
		}
		if (matched.length >= MAX_REPORT_RESULTS) {
			truncated = true;
			break;
		}
		matched.push(resource);
	}
	await withOverrides(ctx.env, ctx.userId, matched.filter((resource) => !loaded.has(resource.id)));
	const seqs = await etagSeqs(ctx.env, calendarCollectionId(ctx.userId), matched.map((resource) => resource.id));
	return streamMultistatus(respond(area, ctx, matched.map((resource) => calendarMember(resource, seqs, ctx.timeZone)), wanted), { href, trailer: () => (truncated ? [{ href, status: 507, error: "<D:number-of-matches-within-limits/>" }] : []) });
}

async function addressBookQuery(ctx: DavContext, root: DavElement, wanted: DavElement | undefined): Promise<Response> {
	const area = "addressbooks";
	const query = parseCardFilter(root);
	if (query === "invalid") return invalidFilter(area);
	if (!query) return unsupportedFilter(area);
	const href = collectionPath(area, ctx.userId);
	const cards = await listCards(ctx.env, ctx.userId, MAX_CARDS);
	let truncated = cards.length > MAX_CARDS;
	let matched = cards.slice(0, MAX_CARDS).filter((card) => cardMatches(card, query.filters, query.allOf));
	const cap = Math.min(query.limit ?? MAX_REPORT_RESULTS, MAX_REPORT_RESULTS);
	if (matched.length > cap) {
		matched = matched.slice(0, cap);
		truncated = true;
	}
	const seqs = await etagSeqs(ctx.env, collectionIdFor(area, ctx.userId), matched.map((card) => card.id));
	const wantsBody = wantsData(wanted, area);
	async function* chunks(): AsyncGenerator<DavResponse[]> {
		if (!matched.length) yield [];
		for (const plan of planCardChunks(matched)) {
			const loaded = wantsBody ? await loadCardBodies(ctx.env, ctx.userId, plan) : plan;
			yield await Promise.all(loaded.map((card) => memberResponse(area, ctx, cardMember(card, seqs), wanted)));
		}
	}
	return streamMultistatus(chunks(), { href, trailer: () => (truncated ? [{ href, status: 507, error: "<D:number-of-matches-within-limits/>" }] : []) });
}

async function syncCollection(area: Area, ctx: DavContext, root: DavElement, wanted: DavElement | undefined): Promise<Response> {
	const level = children(root, NS.dav, "sync-level")[0]?.text.trim();
	if (level === "infinite" || level === "infinity") return precondition(403, "sync-traversal-supported");
	if (level !== "1") return text(400, "sync-level must be 1");
	const tokenElement = children(root, NS.dav, "sync-token")[0];
	if (!tokenElement || !wanted || wanted.name !== "prop") return text(400, "sync-token and prop are required");
	const token = tokenElement.text.trim();
	const cid = collectionIdFor(area, ctx.userId);
	const path = collectionPath(area, ctx.userId);
	const lightWanted = wanted;
	const live = (member: Omit<Member, "body">) => memberResponse(area, ctx, member, lightWanted);

	if (!token) {
		// First sync: the position is read before the listing, so a change made meanwhile is reported again next time.
		const { epoch } = await ensureSyncState(ctx.env, cid);
		const seq = await currentSeq(ctx.env, cid);
		const members = await listMembers(area, ctx);
		if (members === "truncated") return precondition(507, "number-of-matches-within-limits");
		const pages = (async function* (): AsyncGenerator<DavResponse[]> {
			for await (const page of members) yield await Promise.all(page.map(live));
		})();
		return streamMultistatus(pages, { href: path, syncToken: formatSyncToken(ctx.origin, cid, epoch, seq) });
	}
	const result = await changesSince(ctx.env, cid, token);
	if (result === "invalid") return precondition(403, "valid-sync-token");
	const keys = result.changes.map((change) => change.objectKey);
	const names = area === "calendars" ? await liveCalendarNames(ctx.env, ctx.userId, keys) : await liveCardNames(ctx.env, ctx.userId, keys);
	const seqs = await etagSeqs(ctx.env, cid, [...names.keys()]);
	const suffix = area === "calendars" ? ".ics" : ".vcf";
	const responses: DavResponse[] = [];
	for (const key of keys) {
		const row = names.get(key);
		if (row) responses.push(await live({ name: row.name, etag: etagOf(seqs, key, row.updatedAt), lastModified: row.updatedAt, contentType: area === "calendars" ? "text/calendar; charset=utf-8" : "text/vcard; charset=utf-8" }));
		// A resource that is gone or hidden. A destroyed DAV-created resource has lost its stored name with its row; only native ids can be named.
		else responses.push({ href: path + key + suffix, status: 404 });
	}
	const { epoch } = await ensureSyncState(ctx.env, cid);
	const trailer = () => (result.hasMore ? [{ href: path, status: 507, error: "<D:number-of-matches-within-limits/>" }] : []);
	return streamMultistatus(inChunks(responses, 90, (chunk) => chunk), { href: path, trailer, syncToken: formatSyncToken(ctx.origin, cid, epoch, result.seq) });
}

/** REPORT on a calendar or address book collection. The body has been size-checked and parsed already. */
export async function handleReport(area: Area, ctx: DavContext, root: DavElement): Promise<Response> {
	const wanted = wantedProps(root);
	const known = area === "calendars" ? ["calendar-multiget", "calendar-query"] : ["addressbook-multiget", "addressbook-query"];
	const inArea = root.ns === (area === "calendars" ? NS.caldav : NS.carddav) && known.includes(root.name);
	const sync = root.ns === NS.dav && root.name === "sync-collection";
	if (!inArea && !sync) return precondition(403, "supported-report");
	if (!sync && unsupportedData(wanted, area)) return precondition(403, area === "calendars" ? "supported-calendar-data" : "supported-address-data", area === "calendars" ? "C" : "CR");
	if (sync) return syncCollection(area, ctx, root, wanted);
	if (root.name.endsWith("multiget")) return multiget(area, ctx, root, wanted);
	return area === "calendars" ? calendarQuery(ctx, root, wanted) : addressBookQuery(ctx, root, wanted);
}
