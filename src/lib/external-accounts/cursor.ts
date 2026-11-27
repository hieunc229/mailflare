import type { ExternalAccountProtocol } from "./types";

/**
 * The protocol cursor in `external_accounts.sync_cursor` is JSON text, because IMAP and POP3 need different
 * state and neither should force a migration. This module holds the format both the future pollers (F37/F38)
 * and the backup restore enforce; the codec that writes a cursor belongs to the poller that owns it.
 *
 * Expected shapes (F37/F38):
 * - IMAP: `{"uidValidity":<int>,"lastUid":<int>}` — two small integers.
 * - POP3: `{"uidls":["<sha256 hex>", …],"lastCheckedAt":"<ISO-8601>"}` — a capped, hashed list of the UIDLs
 *   already imported.
 *
 * A poller must write through a bounded codec: trim the oldest POP3 UIDLs past the cap, and never store a
 * server-provided string verbatim. The key set here is the whole format — a poller that needs new state adds
 * the key here, and the restore then accepts documents written by that newer code. Nothing is coerced: a
 * cursor is a plain JSON object with the keys and types above, within `SYNC_CURSOR_MAX_BYTES` of UTF-8.
 */
export const SYNC_CURSOR_MAX_BYTES = 64 * 1024;
/** A POP3 row is re-written on every poll; this keeps one account's cursor well under the byte bound. */
export const SYNC_CURSOR_MAX_UIDLS = 4096;
const MAX_UIDL_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;

const CURSOR_KEYS: Record<ExternalAccountProtocol, readonly string[]> = {
	imap: ["uidValidity", "lastUid"],
	pop3: ["uidls", "lastCheckedAt"],
};

const isNonNegativeInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;

function isCursorShape(value: unknown, protocol: ExternalAccountProtocol): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entries = Object.entries(value as Record<string, unknown>);
	if (!entries.every(([key]) => CURSOR_KEYS[protocol].includes(key))) return false;
	for (const [key, item] of entries) {
		if (protocol === "imap") {
			// UIDVALIDITY and the last seen UID are unsigned 32-bit integers on the wire.
			if (typeof item !== "number" || !isNonNegativeInteger(item) || item > 0xffffffff) return false;
			continue;
		}
		if (key === "uidls") {
			if (!Array.isArray(item) || item.length > SYNC_CURSOR_MAX_UIDLS) return false;
			if (!item.every((uidl) => typeof uidl === "string" && uidl.length > 0 && uidl.length <= MAX_UIDL_LENGTH)) return false;
		} else if (typeof item !== "string" || item.length > MAX_TIMESTAMP_LENGTH) {
			return false;
		}
	}
	return true;
}

/**
 * Null/absent (never synced) or JSON text of a plain object in the protocol's own shape, measured in UTF-8
 * bytes rather than JS code units. Primitives, arrays and unknown keys are refused.
 */
export function isSyncCursorFormat(value: unknown, protocol: ExternalAccountProtocol): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value !== "string") return false;
	if (new TextEncoder().encode(value).byteLength > SYNC_CURSOR_MAX_BYTES) return false;
	try {
		return isCursorShape(JSON.parse(value), protocol);
	} catch {
		return false;
	}
}
