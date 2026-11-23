/**
 * A client-controlled map key can be "__proto__": `map[key] = value` then calls
 * the __proto__ setter instead of storing an own property, so the entry silently
 * vanishes (or, for an object value, replaces the map's prototype). Maps we
 * construct are kept null-prototype instead; this helper covers the maps whose
 * construction we do not own, like `ctx.createdIds`, plus single guarded writes.
 * defineProperty bypasses the setter and lands an own enumerable key that
 * Object.keys, JSON.stringify and deep-equal all see.
 */
export function setKey(map: Record<string, unknown>, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
	} else {
		map[key] = value;
	}
}
