type Flags = { isPrivate: boolean; transparent: boolean };

/**
 * The privacy and free/busy flags an event is saved with. A flag the request leaves out keeps the stored value, so an older
 * client that knows nothing about them cannot clear them by editing the title. A flag that is present but not a boolean
 * returns null: the route answers 400 instead of guessing.
 */
export function resolveEventFlags(existing: Flags | null, input: { isPrivate?: unknown; transparent?: unknown }): Flags | null {
	const pick = (value: unknown, kept: boolean | undefined) => (value === undefined ? kept ?? false : typeof value === "boolean" ? value : null);
	const isPrivate = pick(input.isPrivate, existing?.isPrivate);
	const transparent = pick(input.transparent, existing?.transparent);
	return isPrivate === null || transparent === null ? null : { isPrivate, transparent };
}

export const EVENT_FLAGS_ERROR = "isPrivate and transparent must be true or false";
