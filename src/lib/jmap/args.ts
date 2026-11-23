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
 * argument (`{"toString":5}`) breaks; `JSON.stringify` cannot throw on values
 * that arrived over JSON and gives every malformed id a deterministic key.
 */
export function safeIdKey(id: unknown): string {
	return typeof id === "string" ? id : (JSON.stringify(id) ?? String(id));
}

/**
 * `Number()` also coerces through `valueOf`/`toString`, so a malformed numeric
 * argument (`{"toString":5}`) throws instead of reading as NaN. Only the
 * primitive types that never invoke those methods reach `Number`; everything
 * else reads as NaN, the same path `Number({})` already took.
 */
export function numberArg(value: unknown): number {
	return typeof value === "number" || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint" ? Number(value) : NaN;
}
