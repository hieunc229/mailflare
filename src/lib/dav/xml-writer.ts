/** Escape text or an attribute value. Characters XML 1.0 cannot carry are dropped. */
export function escapeXml(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

const STATUS_TEXT: Record<number, string> = { 200: "OK", 403: "Forbidden", 404: "Not Found", 507: "Insufficient Storage" };

export type DavPropstat = { status: number; /** Already-serialised property elements. Callers escape what they put inside. */ props: string[] };
export type DavResponse = { href: string; propstats: DavPropstat[] };

/** The prefixes every response declares once on its root: D = DAV:, C = CalDAV, CR = CardDAV, CS = calendarserver.org. */
const ROOT_NAMESPACES = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/"`;

export function multistatus(responses: DavResponse[]): string {
	const body = responses
		.map(
			({ href, propstats }) =>
				`<D:response><D:href>${escapeXml(href)}</D:href>` +
				propstats
					.map(({ status, props }) => `<D:propstat><D:prop>${props.join("")}</D:prop><D:status>HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ""}</D:status></D:propstat>`)
					.join("") +
				`</D:response>`,
		)
		.join("");
	return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${ROOT_NAMESPACES}>${body}</D:multistatus>`;
}
