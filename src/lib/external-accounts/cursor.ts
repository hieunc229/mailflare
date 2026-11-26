/**
 * The protocol cursor in `external_accounts.sync_cursor` is JSON text, because IMAP and POP3 need different
 * state and neither should force a migration. This module holds the bounds both the future pollers (F37/F38)
 * and the backup restore must enforce; the codec that writes a cursor belongs to the poller that owns it.
 *
 * Expected shapes (F37/F38):
 * - IMAP: `{"uidValidity":<int>,"lastUid":<int>}` — two small integers.
 * - POP3: `{"uidls":["<sha256 hex>", …]}` — a capped, hashed list of already-imported UIDLs.
 *
 * A poller must write through a bounded codec: reject a POP3 list that grows past the cap by trimming the
 * oldest entries, and never store a server-provided string verbatim. The restore path validates the same
 * bounds (format only, no decryption), so a hand-edited backup cannot plant a cursor a poller would choke on.
 */
export const SYNC_CURSOR_MAX_BYTES = 64 * 1024;

/** Null/absent (never synced) or JSON text of an object or array within the bound. Primitives are refused. */
export function isSyncCursorFormat(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value !== "string" || value.length > SYNC_CURSOR_MAX_BYTES) return false;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null;
	} catch {
		return false;
	}
}
