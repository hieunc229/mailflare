import { MAX_XML_BODY, readBodyText } from "./body";
import { DavXmlError, parseDavXml, type DavElement } from "./xml";
import { escapeXml, multistatusHead, multistatusResponse, multistatusTail, type DavPropstat, type DavResponse } from "./xml-writer";

export const NS = {
	dav: "DAV:",
	caldav: "urn:ietf:params:xml:ns:caldav",
	carddav: "urn:ietf:params:xml:ns:carddav",
	cs: "http://calendarserver.org/ns/",
	apple: "http://apple.com/ns/ical/",
};
const PREFIX: Record<string, string> = { [NS.dav]: "D", [NS.caldav]: "C", [NS.carddav]: "CR", [NS.cs]: "CS", [NS.apple]: "ICAL" };

export const BASE_HEADERS = { "Cache-Control": "no-store" };
export const XML_HEADERS = { ...BASE_HEADERS, "Content-Type": "application/xml; charset=utf-8" };
/** A multistatus answer carries at most this much XML before it is cut with a 507 for the collection. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export function text(status: number, message: string, headers: Record<string, string> = {}) {
	return new Response(message, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

/** A DAV precondition error body (RFC 4918 section 16); `ns` is the prefix of the element's namespace. */
export function precondition(status: number, element: string, ns: "D" | "C" | "CR" = "D") {
	return new Response(`<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav"><${ns}:${element}/></D:error>`, { status, headers: XML_HEADERS });
}

/** 403 `DAV:need-privileges` (RFC 3744 section 7.1.1): the user may see the resource but not do this to it. */
export function needPrivileges(resourceHref: string, privilege: "write-content" | "unbind" | "bind" | "write-properties") {
	return new Response(`<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:need-privileges><D:resource><D:href>${escapeXml(resourceHref)}</D:href><D:privilege><D:${privilege}/></D:privilege></D:resource></D:need-privileges></D:error>`, { status: 403, headers: XML_HEADERS });
}

/** A resource as a listing page carries it: name and ETag, no body. */
export type ListedRow = { name: string; etag: string; updatedAt: Date; /** Known without the body (a stored card). */ size?: number };

export type Property = {
	ns: string;
	name: string;
	value: () => string | Promise<string>;
	/** Costly to produce (a body, its length): left out of allprop and propname, and answered only when asked for by name. */
	heavy?: boolean;
};

export const el = (ns: string, name: string, inner = "") => (inner ? `<${PREFIX[ns]}:${name}>${inner}</${PREFIX[ns]}:${name}>` : `<${PREFIX[ns]}:${name}/>`);
export const href = (path: string) => `<D:href>${escapeXml(path)}</D:href>`;
export const collection = (...extra: string[]) => el(NS.dav, "resourcetype", `<D:collection/>${extra.join("")}`);

/** A requested property the server does not have, written in its own namespace. */
const unknownProperty = (ns: string, name: string) => `<${name} xmlns="${escapeXml(ns)}"/>`;

/**
 * Answer a `prop`, `allprop` or `propname` element (undefined: allprop) for one resource. Unknown properties get a
 * 404 propstat of their own; only the properties actually asked for are computed.
 */
export async function selectProps(wanted: DavElement | undefined, resource: { href: string; props: Property[] }): Promise<DavResponse> {
	const mode = wanted?.name ?? "allprop";
	const light = resource.props.filter((prop) => !prop.heavy);
	if (mode === "propname") return { href: resource.href, propstats: [{ status: 200, props: light.map((prop) => el(prop.ns, prop.name)) }] };
	if (mode === "allprop") return { href: resource.href, propstats: [{ status: 200, props: await Promise.all(light.map((prop) => prop.value())) }] };
	const found: string[] = [];
	const missing: string[] = [];
	for (const requested of wanted!.children) {
		const prop = resource.props.find((candidate) => candidate.ns === requested.ns && candidate.name === requested.name);
		if (prop) found.push(await prop.value());
		else missing.push(unknownProperty(requested.ns, requested.name));
	}
	const propstats: DavPropstat[] = [];
	if (found.length || !missing.length) propstats.push({ status: 200, props: found });
	if (missing.length) propstats.push({ status: 404, props: missing });
	return { href: resource.href, propstats };
}

/**
 * The request body of an XML method as a tree: null for an empty body, a ready response for one that is too big,
 * of the wrong type or not well-formed. Run only after authentication.
 */
export async function readXmlBody(request: Request): Promise<DavElement | null | Response> {
	const body = await readBodyText(request, MAX_XML_BODY);
	if (body === null) return text(413, "Request body too large");
	if (!body.trim()) return null;
	const contentType = request.headers.get("content-type");
	if (contentType && !/^(application|text)\/xml(\s*;|$)/i.test(contentType.trim())) return text(415, "Unsupported media type");
	try {
		return parseDavXml(body);
	} catch (error) {
		if (error instanceof DavXmlError) return text(400, "Invalid XML");
		throw error;
	}
}

/** The `prop`, `allprop` or `propname` child of a request, if it has one. */
export const wantedProps = (root: DavElement) => root.children.find((child) => child.ns === NS.dav && ["prop", "allprop", "propname"].includes(child.name));

/**
 * A multistatus response written as `source` yields responses, so memory stays bounded. The first piece is loaded
 * before anything is returned, so a failing query is still an ordinary error response. Output stops at
 * MAX_RESPONSE_BYTES; `trailer` runs last for responses that depend on what was sent (404s, a 507 for the collection).
 */
export async function streamMultistatus(source: AsyncGenerator<DavResponse[]>, options: { href: string; trailer?: () => DavResponse[]; syncToken?: string }): Promise<Response> {
	const encoder = new TextEncoder();
	let next = await source.next();
	let sent = 0;
	let started = false;
	let cut = false;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!started) {
				started = true;
				controller.enqueue(encoder.encode(multistatusHead()));
			}
			if (next.done || cut) {
				const extra = [...(options.trailer?.() ?? []), ...(cut ? [{ href: options.href, status: 507, error: "<D:number-of-matches-within-limits/>" }] : [])];
				controller.enqueue(encoder.encode(extra.map(multistatusResponse).join("") + multistatusTail(cut ? undefined : options.syncToken)));
				controller.close();
				if (cut) await source.return(undefined);
				return;
			}
			const piece = encoder.encode(next.value.map(multistatusResponse).join(""));
			sent += piece.byteLength;
			controller.enqueue(piece);
			next = await source.next();
			if (!next.done && sent >= MAX_RESPONSE_BYTES) cut = true;
		},
		async cancel() {
			await source.return(undefined);
		},
	});
	return new Response(body, { status: 207, headers: XML_HEADERS });
}

/** Responses of an array in groups, as `streamMultistatus` wants them. */
export async function* inChunks<T>(items: T[], size: number, make: (chunk: T[]) => DavResponse[] | Promise<DavResponse[]>): AsyncGenerator<DavResponse[]> {
	if (!items.length) yield [];
	for (let i = 0; i < items.length; i += size) yield await make(items.slice(i, i + size));
}

/** Whether `If-None-Match` (or a `*`) names the current ETag, in which case a GET is answered 304. Weak comparison: `W/` is ignored. */
export const etagListed = (header: string, etag: string) => header.split(",").some((item) => item.trim() === "*" || item.trim().replace(/^W\//, "") === etag);
/** `If-Match` compares strongly (RFC 9110 13.1.1): a weak validator never matches. */
export const etagMatches = (header: string, etag: string) => header.split(",").some((item) => item.trim() === "*" || item.trim() === etag);
