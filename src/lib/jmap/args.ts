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
 * Response-map keys for a destroy list whose items may not be strings. Key and
 * `String()` coercion both invoke the value's own `toString`, which a hostile
 * argument (`{"toString":5}`) breaks. Strings keep themselves — the whole
 * literal namespace is reserved for them first — and every malformed item gets
 * a positional surrogate allocated outside that namespace, so no input can
 * forge a surrogate or push two items onto one entry. Surrogates carry no
 * client content: the per-record verdict is the information, the key is just a
 * placeholder for an item that cannot be a key.
 */
export function safeIdKeys(ids: unknown[]): string[] {
	const reserved = new Set(ids.filter((id): id is string => typeof id === "string"));
	// Monotonic cursor: every allocated key sits below `next`, so a candidate at
	// or above it can only collide with a reserved literal — one forward pass,
	// no rescan even when a long literal run reserves the sequential prefix.
	let next = 0;
	return ids.map((id, index) => {
		if (typeof id === "string") return id;
		let candidate = Math.max(index, next);
		while (reserved.has(`malformed#${candidate}`)) candidate += 1;
		next = candidate + 1;
		return `malformed#${candidate}`;
	});
}

/**
 * `Number()` also coerces through `valueOf`/`toString`, so a malformed numeric
 * argument (`{"toString":5}`) throws instead of reading as NaN. Only the
 * primitive types that never invoke those methods reach `Number`; objects and
 * arrays read as NaN, so malformed shapes take each call site's unusable-value
 * path rather than `Number([1])`'s single-element coercion.
 */
export function numberArg(value: unknown): number {
	return typeof value === "number" || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint" ? Number(value) : NaN;
}
