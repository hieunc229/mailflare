import { authFetch } from "@/lib/auth/client";

const URL_PATH = "/api/calendar/freebusy-link";

export type PublishStatus = { enabled: false } | { enabled: true; createdAt: string };
export type PublishResult<T> = ({ ok: true } & T) | { ok: false };

async function call<T>(init: RequestInit | undefined, pick: (body: Record<string, unknown>) => T | null): Promise<PublishResult<T>> {
	try {
		// The status is checked before the body is read: a proxy's HTML error page is a failure, not a parse error.
		const response = await authFetch(URL_PATH, init);
		if (!response.ok) return { ok: false };
		const picked = pick(((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>);
		return picked ? { ok: true, ...picked } : { ok: false };
	} catch { return { ok: false }; }
}

export const loadPublishStatus = () => call<{ status: PublishStatus }>({ cache: "no-store" }, (body) => typeof body.enabled !== "boolean" ? null : { status: body.enabled ? { enabled: true, createdAt: typeof body.createdAt === "string" ? body.createdAt : "" } : { enabled: false } });
/** `key` is present only when this request made the link: it is stored hashed and cannot be read again. */
export const turnOnPublish = () => call<{ key: string | null }>({ method: "POST" }, (body) => body.enabled === true ? { key: body.created === true && typeof body.key === "string" ? body.key : null } : null);
export const turnOffPublish = () => call<Record<string, never>>({ method: "DELETE" }, (body) => body.enabled === false ? {} : null);

/** The two public addresses for a key: the free/busy file, and the same times as a busy-only calendar to subscribe to. */
export function publishUrls(origin: string, key: string): { ifb: string; ics: string } {
	const ifb = `${origin}/api/calendar/freebusy?key=${encodeURIComponent(key)}`;
	return { ifb, ics: `${ifb}&format=ics` };
}
