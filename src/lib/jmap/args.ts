import { invalidArguments } from "./errors";

/**
 * `ids`/`properties`-style `String[]` method args: anything else is a client
 * error (`invalidArguments`), not a server failure to log as `serverFail`.
 */
export function stringArrayArg(value: unknown, name: string): string[] | null | undefined {
	if (value === undefined || value === null) return value;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalidArguments(`${name} must be an array of strings`);
	return value;
}

/**
 * Response-map key for a destroy-list entry that may not be a string. Key and
 * `String()` coercion both invoke the value's own `toString`, which a hostile
 * argument (`{"toString":5}`) breaks. Strings keep themselves so real ids
 * still echo verbatim; malformed items get a surrogate carrying their list
 * position and a best-effort JSON echo, so distinct items can never collide
 * and `5` can never share `"5"`'s entry. A client string equal to a surrogate
 * is still just an id, and a surrogate can never name a server-minted object,
 * so any residual collision merges two identical bad-id verdicts only.
 */
export function safeIdKey(id: unknown, index: number): string {
	if (typeof id === "string") return id;
	let echo: string;
	try {
		echo = JSON.stringify(id) ?? "unserializable";
	} catch {
		// Cycles and bigints cannot arrive over JSON; belt and suspenders.
		echo = "unserializable";
	}
	return `malformed#${index}=${echo}`;
}

/**
 * `Number()` also coerces through `valueOf`/`toString`, so a malformed numeric
 * argument (`{"toString":5}`) throws instead of reading as NaN. Only the
 * primitive types that never invoke those methods reach `Number`; objects and
 * arrays read as NaN — malformed shapes are treated as unusable input, so
 * `limit:[1]` answers an empty page rather than `Number([1])`'s one row.
 */
export function numberArg(value: unknown): number {
	return typeof value === "number" || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint" ? Number(value) : NaN;
}
