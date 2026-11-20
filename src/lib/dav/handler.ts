import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { authenticateAppPasswordRequest } from "@/lib/auth/app-passwords";
import { getSecurityHeaders } from "@/lib/security/headers";
import { loadCalendarByNames } from "./calendar-store";
import { loadCardBodies, loadCardMetaByNames } from "./card-store";
import { calendarMember, cardMember, collectionIdFor, collectionProperties, collectionPath, memberResponse, propfindCollection, type Area, type DavContext } from "./collections";
import { BASE_HEADERS, collection, el, href, NS, precondition, readXmlBody, selectProps, text, wantedProps, XML_HEADERS, type Property } from "./common";
import { etagSeqs } from "./changes";
import { handleReport } from "./reports";
import { isDavEnabled } from "./settings";
import type { DavElement } from "./xml";
import { escapeXml, multistatus } from "./xml-writer";

const DAV_CLASSES = "1, 3, calendar-access, addressbook";
const ALLOW = "OPTIONS, PROPFIND, REPORT, GET, HEAD";
const MAX_ADDRESSES = 50;
const MEMBER_NAME = /^[A-Za-z0-9._~@+=-]{1,200}$/;

/** `/dav`, `/dav/*` and the two well-known discovery paths. */
export function isDavPath(pathname: string): boolean {
	return pathname === "/dav" || pathname.startsWith("/dav/") || pathname === "/.well-known/caldav" || pathname === "/.well-known/carddav";
}

type Target =
	| { kind: "root" | "principal" | "home"; area?: Area }
	| { kind: "collection"; area: Area }
	| { kind: "resource"; area: Area; name: string }
	| { kind: "bad-name" };

/**
 * Where a request path points: the root, a principal, a home set, the one
 * collection in it or a resource of that collection. Anything else (including
 * other users' ids, which must look the same as ids that do not exist) is null.
 */
function locate(pathname: string, userId: string): Target | null {
	let segments: string[];
	try {
		segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return null;
	}
	if (segments[0] !== "dav") return null;
	if (segments.length === 1) return { kind: "root" };
	const [, area, id, name, member] = segments;
	if (segments.length < 3 || segments.length > 5 || id !== userId) return null;
	if (area === "principals") return segments.length === 3 ? { kind: "principal" } : null;
	if (area !== "calendars" && area !== "addressbooks") return null;
	if (segments.length === 3) return { kind: "home", area };
	if (name !== "default") return null;
	if (segments.length === 4) return { kind: "collection", area };
	const extension = area === "calendars" ? ".ics" : ".vcf";
	if (!member.endsWith(extension)) return { kind: "bad-name" };
	return MEMBER_NAME.test(member) ? { kind: "resource", area, name: member } : { kind: "bad-name" };
}

type DavUser = { id: string; email: string; name: string };

async function userAddresses(env: CloudflareEnv, user: DavUser): Promise<string[]> {
	const owned = await getDb(env)
		.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.userId, user.id))
		.limit(MAX_ADDRESSES);
	return [...new Set([user.email, ...owned.map((row) => `${row.localPart}@${row.hostname}`)].map((address) => address.toLowerCase()))];
}

function properties(kind: "root" | "principal" | "home", area: Area | undefined, user: DavUser, addresses: string[]): { href: string; props: Property[] } {
	const principal = `/dav/principals/${user.id}/`;
	const currentUser: Property = { ns: NS.dav, name: "current-user-principal", value: () => el(NS.dav, "current-user-principal", href(principal)) };
	if (kind === "root") return { href: "/dav/", props: [{ ns: NS.dav, name: "resourcetype", value: () => collection() }, currentUser] };
	if (kind === "principal") {
		return {
			href: principal,
			props: [
				{ ns: NS.dav, name: "resourcetype", value: () => collection(el(NS.dav, "principal")) },
				{ ns: NS.dav, name: "displayname", value: () => el(NS.dav, "displayname", escapeXml(user.name || user.email)) },
				{ ns: NS.dav, name: "principal-URL", value: () => el(NS.dav, "principal-URL", href(principal)) },
				currentUser,
				{ ns: NS.caldav, name: "calendar-home-set", value: () => el(NS.caldav, "calendar-home-set", href(`/dav/calendars/${user.id}/`)) },
				{ ns: NS.carddav, name: "addressbook-home-set", value: () => el(NS.carddav, "addressbook-home-set", href(`/dav/addressbooks/${user.id}/`)) },
				{ ns: NS.caldav, name: "calendar-user-address-set", value: () => el(NS.caldav, "calendar-user-address-set", addresses.map((address) => href(`mailto:${address}`)).join("")) },
			],
		};
	}
	return {
		href: `/dav/${area}/${user.id}/`,
		props: [
			{ ns: NS.dav, name: "resourcetype", value: () => collection() },
			{ ns: NS.dav, name: "displayname", value: () => el(NS.dav, "displayname", area === "calendars" ? "Calendars" : "Contacts") },
			{ ns: NS.dav, name: "owner", value: () => el(NS.dav, "owner", href(principal)) },
			currentUser,
		],
	};
}

/** The PROPFIND body as a tree: null for an empty body (allprop), a response for a bad one. */
async function readPropfindBody(request: Request): Promise<DavElement | null | Response> {
	const root = await readXmlBody(request);
	if (root === null || root instanceof Response) return root;
	const choice = root.children.filter((child) => child.ns === NS.dav);
	if (root.ns !== NS.dav || root.name !== "propfind" || choice.length !== 1 || !["prop", "allprop", "propname"].includes(choice[0].name)) return text(400, "Not a PROPFIND request");
	return root;
}

/** Spend one request from the key's budget. A missing or failing limiter lets the request through, like the other limiters. */
async function withinKeyBudget(env: CloudflareEnv, keyId: string): Promise<boolean> {
	if (!env.DAV_RATE_LIMIT) return true;
	try {
		return (await env.DAV_RATE_LIMIT.limit({ key: `dav:${keyId}` })).success;
	} catch (error) {
		console.warn("DAV rate limiter unavailable", error);
		return true;
	}
}

/** Whether `If-None-Match` (or a `*`) names the current ETag, in which case a GET is answered 304. Weak comparison: `W/` is ignored. */
const etagListed = (header: string, etag: string) => header.split(",").some((item) => item.trim() === "*" || item.trim().replace(/^W\//, "") === etag);
/** `If-Match` compares strongly (RFC 9110 13.1.1): a weak validator never matches. */
const etagMatches = (header: string, etag: string) => header.split(",").some((item) => item.trim() === "*" || item.trim() === etag);

/** GET and HEAD of one resource: the stored body or its generated text, with its ETag. */
async function getResource(area: Area, ctx: DavContext, name: string, request: Request): Promise<Response> {
	const cid = collectionIdFor(area, ctx.userId);
	let body: string;
	let member;
	if (area === "calendars") {
		const [resource] = await loadCalendarByNames(ctx.env, ctx.userId, [name]);
		if (!resource) return text(404, "Not found");
		member = calendarMember(resource, await etagSeqs(ctx.env, cid, [resource.id]), ctx.timeZone);
		body = member.body!();
	} else {
		const [meta] = await loadCardMetaByNames(ctx.env, ctx.userId, [name]);
		const [card] = meta ? await loadCardBodies(ctx.env, ctx.userId, [meta]) : [];
		if (!card) return text(404, "Not found");
		member = cardMember(card, await etagSeqs(ctx.env, cid, [card.id]));
		body = card.body;
	}
	const headers = { ...BASE_HEADERS, ETag: member.etag, "Last-Modified": member.lastModified.toUTCString() };
	const ifMatch = request.headers.get("If-Match");
	if (ifMatch && !etagMatches(ifMatch, member.etag)) return text(412, "Precondition failed", headers);
	const ifNoneMatch = request.headers.get("If-None-Match");
	if (ifNoneMatch && etagListed(ifNoneMatch, member.etag)) return new Response(null, { status: 304, headers });
	const size = String(new TextEncoder().encode(body).byteLength);
	return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: { ...headers, "Content-Type": member.contentType, "Content-Length": size } });
}

/**
 * Entry point for `/dav/*` and the well-known discovery paths, called before
 * the framework because route handlers cannot express PROPFIND. Returns null
 * for paths it does not own. Off until an administrator turns it on (404 for
 * everything); then only app passwords with the `dav` scope are accepted, and
 * only over HTTPS. It always reads the primary database: no D1 read session.
 */
export async function handleDavRequest(request: Request, env: CloudflareEnv): Promise<Response | null> {
	const response = await route(request, env);
	// The framework adds these to its own responses; this path runs before it.
	if (response) for (const { key, value } of getSecurityHeaders()) response.headers.set(key, value);
	return response;
}

async function route(request: Request, env: CloudflareEnv): Promise<Response | null> {
	const url = new URL(request.url);
	if (!isDavPath(url.pathname)) return null;
	if (!(await isDavEnabled(env))) return text(404, "Not found");

	if (request.method === "OPTIONS") return new Response(null, { status: 200, headers: { ...BASE_HEADERS, DAV: DAV_CLASSES, Allow: ALLOW, "Content-Length": "0" } });

	let pathname = url.pathname;
	if (pathname.startsWith("/.well-known/")) {
		// iOS drops Authorization when it follows a redirect, so answer in place when credentials came with the request.
		if (!request.headers.get("Authorization")) return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: `${url.origin}/dav/` } });
		pathname = "/dav/";
	}

	const protocol = pathname.startsWith("/dav/addressbooks/") ? "carddav" : "caldav";
	const auth = await authenticateAppPasswordRequest(env, request, protocol);
	if (auth === "insecure") return text(403, "HTTPS is required for calendar and contacts sync. Behind a reverse proxy, set TRUST_PROXY so its X-Forwarded-Proto is believed.");
	if (auth === "throttled") return text(429, "Too many attempts", { "Retry-After": "60" });
	if (!auth) return text(401, "Unauthorized", { "WWW-Authenticate": 'Basic realm="Mailflare", charset="UTF-8"' });
	if (!(await withinKeyBudget(env, auth.keyId))) return text(503, "Too many requests", { "Retry-After": "30" });

	if (request.method === "MKCALENDAR" || request.method === "MKCOL") return text(403, "Collections cannot be created");
	const target = locate(pathname, auth.userId);
	if (!target) return text(404, "Not found");
	if ("area" in target && target.area === "calendars" && !auth.user.calendarEnabled) return text(403, "Calendar is turned off for this account");
	if (target.kind === "bad-name") return text(400, "Invalid resource name");

	const user: DavUser = { id: auth.userId, email: auth.user.email, name: auth.user.name };
	const ctx: DavContext = { env, userId: auth.userId, email: auth.user.email, name: auth.user.name, timeZone: auth.user.timeZone ?? null, origin: url.origin };

	if ((request.method === "GET" || request.method === "HEAD") && target.kind === "resource") return getResource(target.area, ctx, target.name, request);

	if (request.method === "REPORT" && target.kind === "collection") {
		const depth = request.headers.get("Depth")?.trim().toLowerCase();
		if (depth === "infinity") return precondition(403, "propfind-finite-depth");
		if (depth !== undefined && depth !== "0" && depth !== "1") return text(400, "Invalid Depth header");
		const root = await readXmlBody(request);
		if (root instanceof Response) return root;
		if (!root) return text(400, "A REPORT needs a request body");
		return handleReport(target.area, ctx, root);
	}

	if (request.method !== "PROPFIND") return text(405, "Method not allowed", { Allow: ALLOW });

	const depth = request.headers.get("Depth")?.trim().toLowerCase();
	if (depth === undefined || depth === "infinity") return precondition(403, "propfind-finite-depth");
	if (depth !== "0" && depth !== "1") return text(400, "Invalid Depth header");
	const parsed = await readPropfindBody(request);
	if (parsed instanceof Response) return parsed;
	const wanted = parsed ? wantedProps(parsed) : undefined;

	if (target.kind === "collection") {
		return propfindCollection(target.area, ctx, wanted, depth);
	}
	if (target.kind === "resource") return propfindResource(ctx, target, wanted);

	const addresses = target.kind === "principal" ? await userAddresses(env, user) : [];
	const responses = [await selectProps(wanted, properties(target.kind, target.area, user, addresses))];
	// The home set's one child is the collection itself.
	if (target.kind === "home" && depth === "1") responses.push(await selectProps(wanted, { href: collectionPath(target.area!, ctx.userId), props: collectionProperties(target.area!, ctx) }));
	return new Response(multistatus(responses), { status: 207, headers: XML_HEADERS });
}

/** PROPFIND on one resource (Depth 0 or 1 alike: it has no children). */
async function propfindResource(ctx: DavContext, target: { area: Area; name: string }, wanted: DavElement | undefined): Promise<Response> {
	const cid = collectionIdFor(target.area, ctx.userId);
	let member;
	if (target.area === "calendars") {
		const [resource] = await loadCalendarByNames(ctx.env, ctx.userId, [target.name]);
		member = resource && calendarMember(resource, await etagSeqs(ctx.env, cid, [resource.id]), ctx.timeZone);
	} else {
		const [meta] = await loadCardMetaByNames(ctx.env, ctx.userId, [target.name]);
		member = meta && cardMember(meta, await etagSeqs(ctx.env, cid, [meta.id]));
	}
	if (!member) return text(404, "Not found");
	return new Response(multistatus([await memberResponse(target.area, ctx, member, wanted)]), { status: 207, headers: XML_HEADERS });
}
