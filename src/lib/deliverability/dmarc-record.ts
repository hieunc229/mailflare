/**
 * Edits the `rua` tag of a DMARC TXT record to add or remove our report address and nothing else: every other
 * tag, its spacing and its order are kept byte for byte.
 */
const NOT_DMARC = "Not a DMARC record";

function assertDmarc(record: string) {
	if (!/^\s*v=DMARC1\s*(?:;|$)/i.test(record)) throw new Error(NOT_DMARC);
}

function assertAddress(address: string) {
	if (!/^[^\s,;@!<>"]+@[a-z0-9.-]+$/i.test(address)) throw new Error("Invalid report address");
}

/** `mailto:a@b!10m` -> `mailto:a@b`, compared case-insensitively. */
const destination = (entry: string) => entry.trim().replace(/![0-9]+[kmgt]?$/i, "").toLowerCase();

const RUA = /^(\s*rua\s*=\s*)([\s\S]*?)(\s*)$/i;

function find(segments: string[]) {
	return segments.findIndex((segment) => /^\s*rua\s*=/i.test(segment));
}

export function hasRuaUri(record: string, address: string): boolean {
	const segments = record.split(";");
	const index = find(segments);
	if (index < 0) return false;
	const value = RUA.exec(segments[index])?.[2] ?? "";
	return value.split(",").some((entry) => destination(entry) === `mailto:${address.toLowerCase()}`);
}

export function withRuaUri(record: string, address: string): string {
	assertDmarc(record);
	assertAddress(address);
	const uri = `mailto:${address}`;
	if (hasRuaUri(record, address)) return record;
	const segments = record.split(";");
	const index = find(segments);
	if (index < 0) {
		const base = record.replace(/\s+$/, "");
		return `${base}${base.endsWith(";") ? " " : "; "}rua=${uri}`;
	}
	const [, key, value, trailing] = RUA.exec(segments[index]) as RegExpExecArray;
	segments[index] = `${key}${value.trim() ? `${value.replace(/\s+$/, "")},${uri}` : uri}${trailing}`;
	return segments.join(";");
}

export function withoutRuaUri(record: string, address: string): string {
	assertDmarc(record);
	assertAddress(address);
	if (!hasRuaUri(record, address)) return record;
	const segments = record.split(";");
	const index = find(segments);
	const [, key, value, trailing] = RUA.exec(segments[index]) as RegExpExecArray;
	const kept = value.split(",").filter((entry) => entry.trim() && destination(entry) !== `mailto:${address.toLowerCase()}`);
	if (kept.length === 0) segments.splice(index, 1);
	else segments[index] = `${key}${kept.map((entry) => entry.trim()).join(",")}${trailing}`;
	return segments.join(";");
}
