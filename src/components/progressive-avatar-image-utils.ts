export function getAvatarPreviewUrl(src: string): string {
	const url = new URL(src, "http://localhost");
	url.searchParams.set("variant", "preview");
	return `${url.pathname}${url.search}`;
}

const LOADED_STORAGE_KEY = "mailflare:avatars-loaded";
const MAX_REMEMBERED = 200;
/** Matches the Cache-Control the avatar route sends: versioned URLs are immutable, others live five minutes. */
const VERSIONED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNVERSIONED_TTL_MS = 5 * 60 * 1000;

let loadedFull: Map<string, number> | null = null;

function readLoaded(): Map<string, number> {
	if (loadedFull) return loadedFull;
	loadedFull = new Map();
	try {
		const stored = JSON.parse(window.localStorage.getItem(LOADED_STORAGE_KEY) || "[]") as Array<[string, number]>;
		const now = Date.now();
		for (const [src, expires] of stored) if (typeof src === "string" && expires > now) loadedFull.set(src, expires);
	} catch {
		// Storage can be unavailable or hold unreadable data; fall back to this page's memory.
	}
	return loadedFull;
}

/** Whether the full-size avatar finished loading before and should still be in the browser cache. */
export function wasAvatarLoaded(src: string): boolean {
	if (typeof window === "undefined") return false;
	const expires = readLoaded().get(src);
	return expires !== undefined && expires > Date.now();
}

export function rememberAvatarLoaded(src: string): void {
	if (typeof window === "undefined") return;
	const loaded = readLoaded();
	const versioned = new URL(src, "http://localhost").searchParams.has("v");
	loaded.delete(src);
	loaded.set(src, Date.now() + (versioned ? VERSIONED_TTL_MS : UNVERSIONED_TTL_MS));
	while (loaded.size > MAX_REMEMBERED) loaded.delete(loaded.keys().next().value as string);
	try {
		window.localStorage.setItem(LOADED_STORAGE_KEY, JSON.stringify([...loaded]));
	} catch {
		// Remembering across reloads is optional.
	}
}
