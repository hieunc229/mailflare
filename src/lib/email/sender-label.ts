import { getEmailAddress } from "@/lib/email/address";

// Bidi and control characters can make a display name render as something other
// than its stored text. Keep the same set the Web Push hardening used.
// eslint-disable-next-line no-control-regex
const UNSAFE_LABEL_CHARS = /[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g;

/**
 * One-line sender label for OS notifications: the resolved display name beside
 * the real address, so a spoofed name cannot hide where the message came from.
 * A message's `from` is its full `"Name" <address>` header, so only the bare
 * address is used inside the angle brackets.
 */
export function formatSenderLabel(from: string, name: string | null | undefined): string {
	const address = getEmailAddress(from).trim() || from.trim();
	const cleanName = (name ?? "").replace(UNSAFE_LABEL_CHARS, "").trim();
	const sender = cleanName && cleanName.toLowerCase() !== address.toLowerCase()
		? `${cleanName.slice(0, 120)} <${address}>`
		: address;
	return sender.slice(0, 240);
}
