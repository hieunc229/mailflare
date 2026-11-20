import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { authenticateAppPasswordRequest } from "@/lib/auth/app-passwords";
import { getSecurityHeaders } from "@/lib/security/headers";
import { MAX_XML_BODY, readBodyText } from "./body";
import { isDavEnabled } from "./settings";
import { DavXmlError, parseDavXml, type DavElement } from "./xml";
import { escapeXml, multistatus, type DavPropstat, type DavResponse } from "./xml-writer";

const NS = {
	dav: "DAV:",
	caldav: "urn:ietf:params:xml:ns:caldav",
	carddav: "urn:ietf:params:xml:ns:carddav",
	cs: "http://calendarserver.org/ns/",
};
const PREFIX: Record<string, string> = { [NS.dav]: "D", [NS.caldav]: "C", [NS.carddav]: "CR", [NS.cs]: "CS" };

const DAV_CLASSES = "1, 3, calendar-access, addressbook";
const ALLOW = "OPTIONS, PROPFIND";
const BASE_HEADERS = { "Cache-Control": "no-store" };
const XML_HEADERS = { ...BASE_HEADERS, "Content-Type": "application/xml; charset=utf-8" };
const MAX_ADDRESSES = 50;

/** `/dav`, `/dav/*` and the two well-known discovery paths. */
export function isDavPath(pathname: string): boolean {
	return pathname === "/dav" || pathname.startsWith("/dav/") || pathname === "/.well-known/caldav" || pathname === "/.well-known/carddav";
}

function text(status: number, message: string, headers: Record<string, string> = {}) {
	return new Response(message, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

/** A DAV precondition error body (RFC 4918 section 16). */
function precondition(status: number, element: string) {
	return new Response(`<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:${element}/></D:error>`, { status, headers: XML_HEADERS });
}

/**
 * Where a request path points: the root, a principal, or a home set. Anything
 * else (including other users' ids, which must look the same as ids that do
 * not exist) is null.
 */
function locate(pathname: string, userId: string): { kind: "root" | "principal" | "calendars" | "addressbooks" } | null {
	let segments: string[];
	try {
		segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return null;
	}
	if (segments[0] !== "dav") return null;
	if (segments.length === 1) return { kind: "root" };
	const [, area, id] = segments;
	if (segments.length !== 3 || id !== userId) return null;
	return area === "principals" || area === "calendars" || area === "addressbooks" ? { kind: area === "principals" ? "principal" : area } : null;
}

type Property = { ns: string; name: string; value: () => string };
type DavUser = { id: string; email: string; name: string };

const el = (ns: string, name: string, inner = "") => (inner ? `<${PREFIX[ns]}:${name}>${inner}</${PREFIX[ns]}:${name}>` : `<${PREFIX[ns]}:${name}/>`);
const href = (path: string) => `<D:href>${escapeXml(path)}</D:href>`;
const collection = (...extra: string[]) => el(NS.dav, "resourcetype", `<D:collection/>${extra.join("")}`);

async function userAddresses(env: CloudflareEnv, user: DavUser): Promise<string[]> {
	const owned = await getDb(env)
		.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.userId, user.id))
		.limit(MAX_ADDRESSES);
	return [...new Set([user.email, ...owned.map((row) => `${row.localPart}@${row.hostname}`)].map((address) => address.toLowerCase()))];
}

function properties(kind: "root" | "principal" | "calendars" | "addressbooks", user: DavUser, addresses: string[]): { href: string; props: Property[] } {
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
		href: `/dav/${kind}/${user.id}/`,
		props: [
			{ ns: NS.dav, name: "resourcetype", value: () => collection() },
			{ ns: NS.dav, name: "displayname", value: () => el(NS.dav, "displayname", kind === "calendars" ? "Calendars" : "Contacts") },
			{ ns: NS.dav, name: "owner", value: () => el(NS.dav, "owner", href(principal)) },
			currentUser,
		],
	};
}

/** A requested property the server does not have, written in its own namespace. */
const unknownProperty = (ns: string, name: string) => `<${name} xmlns="${escapeXml(ns)}"/>`;

function propfindResponse(request: DavElement | null, resource: { href: string; props: Property[] }): DavResponse {
	const wanted = request?.children.find((child) => child.ns === NS.dav);
	const mode = wanted?.name ?? "allprop";
	if (mode === "propname") return { href: resource.href, propstats: [{ status: 200, props: resource.props.map((prop) => el(prop.ns, prop.name)) }] };
	if (mode === "allprop") return { href: resource.href, propstats: [{ status: 200, props: resource.props.map((prop) => prop.value()) }] };
	const found: string[] = [];
	const missing: string[] = [];
	for (const requested of wanted!.children) {
		const prop = resource.props.find((candidate) => candidate.ns === requested.ns && candidate.name === requested.name);
		if (prop) found.push(prop.value());
		else missing.push(unknownProperty(requested.ns, requested.name));
	}
	const propstats: DavPropstat[] = [];
	if (found.length || !missing.length) propstats.push({ status: 200, props: found });
	if (missing.length) propstats.push({ status: 404, props: missing });
	return { href: resource.href, propstats };
}

/** The PROPFIND body as a tree: null for an empty body (allprop), a DavXmlError response otherwise. */
async function readPropfindBody(request: Request): Promise<DavElement | null | Response> {
	const body = await readBodyText(request, MAX_XML_BODY);
	if (body === null) return text(413, "Request body too large");
	if (!body.trim()) return null;
	const contentType = request.headers.get("content-type");
	if (contentType && !/^(application|text)\/xml(\s*;|$)/i.test(contentType.trim())) return text(415, "Unsupported media type");
	let root: DavElement;
	try {
		root = parseDavXml(body);
	} catch (error) {
		if (error instanceof DavXmlError) return text(400, "Invalid XML");
		throw error;
	}
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
	if (target.kind === "calendars" && !auth.user.calendarEnabled) return text(403, "Calendar is turned off for this account");

	if (request.method !== "PROPFIND") return text(405, "Method not allowed", { Allow: ALLOW });

	const depth = request.headers.get("Depth")?.trim().toLowerCase();
	if (depth === undefined || depth === "infinity") return precondition(403, "propfind-finite-depth");
	if (depth !== "0" && depth !== "1") return text(400, "Invalid Depth header");
	const parsed = await readPropfindBody(request);
	if (parsed instanceof Response) return parsed;

	const user: DavUser = { id: auth.userId, email: auth.user.email, name: auth.user.name };
	const addresses = target.kind === "principal" ? await userAddresses(env, user) : [];
	// No collections exist below the home sets yet, so depth 1 has nothing more to list.
	return new Response(multistatus([propfindResponse(parsed, properties(target.kind, user, addresses))]), { status: 207, headers: XML_HEADERS });
}
