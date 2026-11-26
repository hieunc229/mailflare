type Flags = { isPrivate: boolean; transparent: boolean };

/**
 * The privacy and free/busy flags an event is saved with. A flag the request leaves out (or sends as anything but a boolean)
 * keeps the stored value, so an older client that knows nothing about them cannot clear them by editing the title.
 */
export function resolveEventFlags(existing: Flags | null, input: { isPrivate?: unknown; transparent?: unknown }): Flags {
	return {
		isPrivate: typeof input.isPrivate === "boolean" ? input.isPrivate : existing?.isPrivate ?? false,
		transparent: typeof input.transparent === "boolean" ? input.transparent : existing?.transparent ?? false,
	};
}
