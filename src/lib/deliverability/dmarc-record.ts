/**
 * Edits the `rua` tag of a DMARC or TLS-RPT TXT record to add or remove our report address and nothing else: every
 * other tag, its spacing and its order are kept byte for byte. Both record types share the tag syntax; only the
 * version tag differs.
 */
type Kind = { version: string; label: string };
const DMARC: Kind = { version: "DMARC1", label: "DMARC" };
const TLS_RPT: Kind = { version: "TLSRPTv1", label: "TLS-RPT" };

function assertKind(record: string, kind: Kind) {
	if (!new RegExp(`^\\s*v=${kind.version}\\s*(?:;|$)`, "i").test(record)) throw new Error(`Not a ${kind.label} record`);
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

function addUri(record: string, address: string, kind: Kind): string {
	assertKind(record, kind);
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

function removeUri(record: string, address: string, kind: Kind): string {
	assertKind(record, kind);
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

export const withRuaUri = (record: string, address: string) => addUri(record, address, DMARC);
export const withoutRuaUri = (record: string, address: string) => removeUri(record, address, DMARC);
export const withTlsRuaUri = (record: string, address: string) => addUri(record, address, TLS_RPT);
export const withoutTlsRuaUri = (record: string, address: string) => removeUri(record, address, TLS_RPT);
/** `hasRuaUri` only reads the `rua` tag, so it serves both record types. */
export const hasTlsRuaUri = hasRuaUri;
