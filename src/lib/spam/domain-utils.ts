import { findHeader } from "./analyzers/utils";

/** Second-level suffixes under which names are registered, so `shop.example.co.uk` reduces to `example.co.uk`. */
const MULTI_PART_SUFFIXES = new Set([
	"co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
	"com.au", "net.au", "org.au", "edu.au", "gov.au",
	"co.nz", "org.nz", "net.nz",
	"co.jp", "ne.jp", "or.jp", "ac.jp",
	"co.kr", "or.kr",
	"com.br", "net.br", "org.br",
	"com.mx", "com.ar", "com.co", "com.pe",
	"co.za", "org.za",
	"com.cn", "net.cn", "org.cn",
	"com.hk", "com.tw", "com.sg", "com.my", "com.ph", "co.th", "co.id",
	"co.in", "net.in", "org.in",
	"co.il", "org.il",
	"com.tr", "com.ua", "com.pl",
	"co.at", "or.at", "gv.at",
]);

/** The domain a name is registered under (approximate public-suffix handling, no list dependency). */
export function registrableDomain(host: string): string {
	const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const lastTwo = labels.slice(-2).join(".");
	return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** The label that identifies the owner, e.g. `paypal` for `mail.paypal.co.uk`. */
export function domainOwnerLabel(host: string): string {
	return registrableDomain(host).split(".")[0] ?? "";
}

export function isPublicIpv4(value: string): boolean {
	const parts = value.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 169 && b === 254) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	return true;
}

/**
 * The IP of the server that handed the message to our MX, from the topmost Received header. Only the
 * receiving server writes that header, so a sender cannot forge it; at worst a missing one means no lookup.
 */
export function extractSenderIp(headers?: Record<string, string>): string | null {
	const received = findHeader(headers, "received");
	if (!received) return null;
	const first = received.split(/;\s*(?:mon|tue|wed|thu|fri|sat|sun),/i)[0];
	for (const match of first.matchAll(/\[(?:IPv6:)?(\d{1,3}(?:\.\d{1,3}){3})\]/gi)) {
		if (isPublicIpv4(match[1])) return match[1];
	}
	return null;
}

const HOMOGLYPHS: [RegExp, string][] = [
	[/rn/g, "m"],
	[/vv/g, "w"],
	[/cl/g, "d"],
	[/0/g, "o"],
	[/[1i|]/g, "l"],
	[/5/g, "s"],
	[/3/g, "e"],
	[/-/g, ""],
];

/** Folds characters that look alike so `paypa1` and `rnicrosoft` compare equal to the real names. */
export function foldHomoglyphs(label: string): string {
	return HOMOGLYPHS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), label.toLowerCase());
}

/** Edit distance counting a swap of two neighbouring characters as one edit. */
export function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < cols; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
		}
	}
	return d[a.length][b.length];
}

/** True when `candidate` is not `known` but looks close enough to be mistaken for it. */
export function isLookalikeDomain(candidate: string, known: string): boolean {
	const a = registrableDomain(candidate);
	const b = registrableDomain(known);
	if (!a || !b || a === b) return false;
	const labelA = a.split(".")[0];
	const labelB = b.split(".")[0];
	// The same name under another suffix (example.ch / example.com) is usually the same owner.
	if (labelB.length < 5 || labelA === labelB) return false;
	if (foldHomoglyphs(labelA) === foldHomoglyphs(labelB)) return true;
	const allowed = labelB.length >= 9 ? 2 : 1;
	return editDistance(labelA, labelB) <= allowed;
}
