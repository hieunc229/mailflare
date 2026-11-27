import { unescapeText } from "@/lib/calendar/invite";
import { isDavAddress } from "./address";
import { readComponent, type Component } from "./content-lines";

export const MAX_CARD_UID = 191;
/** Addresses mirrored from one card (spec 8.2). */
export const MAX_CARD_EMAILS = 20;
const MAX_FN = 200;

/** `group`: a group card (`KIND:group`, or Apple's `X-ADDRESSBOOKSERVER-KIND:group`), which is stored and served but never mirrored into contacts (spec 8.2). */
export type ParsedCard = { uid: string; version: "3.0" | "4.0"; fn: string; emails: string[]; group: boolean };
/** The CardDAV precondition (RFC 6352 section 6.3.2.1) a refused body violates. */
export type CardRefusal = "valid-address-data" | "supported-address-data";

/** A property's name without the group prefix Apple writes (`item1.EMAIL`). */
const nameOf = (name: string) => name.slice(name.indexOf(".") + 1);
const values = (card: Component, name: string) => card.props.filter((property) => nameOf(property.name) === name);

/**
 * A vCard PUT body: exactly one VCARD, VERSION 3.0 or 4.0, a UID. The body itself is stored as it came. The name is FN,
 * else N's given and family names, else the first address; addresses are the EMAIL values that look like one (at most 20,
 * lower-cased, `mailto:` dropped). Bounded and linear (readComponent); never throws, nothing is fetched (PHOTO and URL are text).
 */
export function parseCard(body: string): ParsedCard | { error: CardRefusal } {
	const card = readComponent(body, "VCARD");
	if (!card) return { error: "valid-address-data" };
	const version = values(card, "VERSION")[0]?.value.trim();
	if (version !== "3.0" && version !== "4.0") return { error: "supported-address-data" };
	const uid = values(card, "UID")[0]?.value.trim() ?? "";
	if (!uid || uid.length > MAX_CARD_UID || /[\u0000-\u001f\u007f]/.test(uid)) return { error: "valid-address-data" };
	const emails: string[] = [];
	for (const property of values(card, "EMAIL")) {
		if (emails.length >= MAX_CARD_EMAILS) break;
		const address = property.value.trim().replace(/^mailto:/i, "").toLowerCase();
		if (isDavAddress(address) && !emails.includes(address)) emails.push(address);
	}
	const [family = "", given = ""] = (values(card, "N")[0]?.value ?? "").split(";");
	const fn = unescapeText(values(card, "FN")[0]?.value ?? "").trim() || [given, family].map((part) => unescapeText(part).trim()).filter(Boolean).join(" ") || emails[0] || "";
	const group = ["KIND", "X-ADDRESSBOOKSERVER-KIND"].some((kind) => values(card, kind).some((property) => property.value.trim().toLowerCase() === "group"));
	return { uid, version, fn: fn.slice(0, MAX_FN), emails, group };
}
