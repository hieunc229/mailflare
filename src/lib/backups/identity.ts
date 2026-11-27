import type { DatabaseDialect } from "@/db/dialect";

/**
 * Identity comparison for `external_accounts` rows taken from a backup, kept apart from the restore so the rules
 * can be tested on their own.
 */

/**
 * How the destination compares the account identity, so the in-document duplicate check catches what its unique
 * index would catch — and never refuses a document the destination would accept.
 *
 * SQLite, PostgreSQL and D1 compare text byte for byte, so those are exact. MySQL compares with a per-column
 * collation, and only one of them can be mirrored exactly from JavaScript:
 *
 * - `utf8mb4_bin` is case-sensitive, and ignores trailing ASCII spaces only when its `PAD_ATTRIBUTE` says PAD SPACE
 *   (read from `information_schema.COLLATIONS`, never guessed from the collation's name).
 * - Everything else — `_ci`, `_cs`, `_as_cs`, an accent-insensitive UCA collation, a language-specific one such as
 *   `utf8mb4_tr_0900_ai_ci` where `I` and `i` are *distinct* — is compared **exactly**: a name is not enough to
 *   reproduce its equality, and refusing a valid backup is worse than missing a duplicate. A real collision is then
 *   caught by the unique index: rolled back where the driver can hold a transaction, and reported with the
 *   partial-restore warning where it cannot.
 */
export type ColumnCollations = Record<"id" | "mailbox_id" | "host" | "username", { collation: string | null; padsSpaces: boolean }>;

export const exactComparator = {
	id: (id: string) => id,
	identity: (mailboxId: string, host: string, username: string) => JSON.stringify([mailboxId, host, username]),
};

/** The one collation whose equality is reproducible here: case-sensitive, with optional trailing ASCII-space padding. */
const EMULATED_COLLATION = "utf8mb4_bin";

export function identityComparator(dialect: DatabaseDialect, columns: ColumnCollations | null) {
	if (dialect !== "mysql" || !columns) return exactComparator;
	/** The comparable form of a value, or the value itself when this column's collation is not emulated. */
	const key = (value: string, column: keyof ColumnCollations) => {
		const rules = columns[column];
		if (rules.collation !== EMULATED_COLLATION || !rules.padsSpaces) return value;
		// Only the ASCII space pads; `trimEnd()` would also swallow NBSP, which the server keeps.
		return value.replace(/ +$/, "");
	};
	return {
		id: (id: string) => key(id, "id"),
		identity: (mailboxId: string, host: string, username: string) =>
			JSON.stringify([key(mailboxId, "mailbox_id"), key(host, "host"), key(username, "username")]),
	};
}

/**
 * The collation and pad attribute of the four identity columns, or null when they cannot be read (a restricted
 * account, an older server): the comparison then stays exact, which accepts rather than refuses.
 */
export async function externalAccountCollations(db: D1Database): Promise<ColumnCollations | null> {
	const columns = ["id", "mailbox_id", "host", "username"] as const;
	try {
		const result = await db
			.prepare(
				"SELECT COLUMN_NAME AS name, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = database() AND TABLE_NAME = 'external_accounts' AND COLUMN_NAME IN ('id', 'mailbox_id', 'host', 'username')",
			)
			.all<{ name?: string; NAME?: string; collation?: string; COLLATION?: string }>();
		const found: Partial<Record<(typeof columns)[number], string | null>> = {};
		for (const row of result.results) {
			const name = (row.name ?? row.NAME)?.toLowerCase();
			if (!columns.includes(name as (typeof columns)[number])) continue;
			const collation = row.collation ?? row.COLLATION ?? null;
			found[name as (typeof columns)[number]] = collation ? String(collation) : null;
		}
		// Every column has to be known: a partial answer would compare some of the tuple with guessed rules.
		if (columns.some((column) => found[column] === undefined)) return null;
		// The pad attribute is a separate lookup, and a failure there only costs the trailing-space emulation.
		const padsSpaces = await collationPadAttributes(db, Object.values(found).filter((value): value is string => typeof value === "string"));
		return Object.fromEntries(columns.map((column) => [column, { collation: found[column] ?? null, padsSpaces: padsSpaces.get(found[column] ?? "") ?? false }])) as ColumnCollations;
	} catch {
		return null;
	}
}

/** `PAD_ATTRIBUTE` per collation name: `PAD SPACE` or `NO PAD`. Missing entries are treated as no padding. */
export async function collationPadAttributes(db: D1Database, names: string[]): Promise<Map<string, boolean>> {
	const wanted = [...new Set(names)];
	if (wanted.length === 0) return new Map();
	try {
		const placeholders = wanted.map(() => "?").join(", ");
		const result = await db
			.prepare(`SELECT COLLATION_NAME AS name, PAD_ATTRIBUTE AS pad FROM information_schema.COLLATIONS WHERE COLLATION_NAME IN (${placeholders})`)
			.bind(...wanted)
			.all<{ name?: string; NAME?: string; pad?: string; PAD?: string }>();
		const pads = new Map<string, boolean>();
		for (const row of result.results) {
			const name = row.name ?? row.NAME;
			const pad = (row.pad ?? row.PAD ?? "").toUpperCase();
			if (name) pads.set(String(name), pad === "PAD SPACE");
		}
		return pads;
	} catch {
		return new Map();
	}
}
