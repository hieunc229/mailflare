/**
 * Rules for the two text values that identify an external account. The API validates a create/update with
 * them, and the backup restore applies the same rules to imported rows, because a backup is portable: a value
 * SQLite accepted must also fit PostgreSQL and MySQL, or the restore fails halfway through.
 */
import { isValidHostname, normalizeHostname } from "@/lib/domains/utils";

/** IPv4 literal, allowed alongside hostnames for a mail server on a LAN. */
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The longest host or login the MySQL identity columns can index (`varchar(191)`). */
export const MAX_IDENTITY_LENGTH = 191;

/** Whether a value is a host a poller could dial: a DNS name or an IPv4 literal, already normalised. */
export function isExternalAccountHost(value: string): boolean {
	return IPV4_PATTERN.test(value) || isValidHostname(value);
}

/**
 * Whether a host is stored the way the API stores one. The API lowercases and strips a trailing dot before
 * saving, so an imported row that would change under `normalizeHostname` is not something this app wrote: it
 * is a URL with a port or path, or a host with different case. Rejected rather than rewritten.
 */
export function isStoredExternalAccountHost(value: string): boolean {
	return value === normalizeHostname(value) && isExternalAccountHost(value);
}

/** Control characters never belong in a mail server host or login, and PostgreSQL cannot store a NUL at all. */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

export const CONTROL_CHARACTER_MESSAGE = "The value contains a control character";

export function hasControlCharacter(value: string): boolean {
	return CONTROL_CHARACTER.test(value);
}
