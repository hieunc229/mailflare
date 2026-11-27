import { authFetch } from "@/lib/auth/client";
import type { CalendarGrantRole, ShareEntry } from "@/lib/calendar/shares-types";

export type Failed = { ok: false; status: number; code?: string };

const base = (calendarId: string) => `/api/calendar/calendars/${encodeURIComponent(calendarId)}/shares`;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function call<T>(url: string, init: RequestInit | undefined, pick: (body: Record<string, unknown>) => T): Promise<({ ok: true } & T) | Failed> {
	try {
		const response = await authFetch(url, init);
		if (!response.ok) return { ok: false, status: response.status, code: ((await response.json().catch(() => ({}))) as { code?: string }).code };
		return { ok: true, ...pick(await response.json().catch(() => ({})) as Record<string, unknown>) };
	} catch { return { ok: false, status: 0 }; }
}

export const loadShares = (calendarId: string) => call(base(calendarId), undefined, (body) => ({ shares: (body.shares ?? []) as ShareEntry[] }));
export const addShare = (calendarId: string, email: string, role: CalendarGrantRole) => call(base(calendarId), json("POST", { email, role }), (body) => ({ share: body.share as ShareEntry }));
/** The grant comes back under a new id: a role change replaces it (the server's rule for phones). */
export const changeShareRole = (calendarId: string, id: string, role: CalendarGrantRole) => call(base(calendarId), json("PATCH", { id, role }), (body) => ({ share: body.share as ShareEntry }));
/** `self` is true when the grant removed was the caller's own: a manager who removes themselves can no longer see the calendar. */
export const removeShare = (calendarId: string, id: string) => call(base(calendarId), json("DELETE", { id }), (body) => ({ self: body.self === true }));

export type RemoveOutcome = { kind: "cancelled" } | { kind: "removed" } | { kind: "self" } | { kind: "failed"; status: number; code?: string };

/** Ask first, then remove; the dialog's behaviour after each outcome is the caller's. */
export async function runRemove(deps: { share: ShareEntry; calendarId: string; confirm: (name: string) => Promise<boolean>; remove: (calendarId: string, id: string) => Promise<({ ok: true; self: boolean } | Failed)> }): Promise<RemoveOutcome> {
	if (!await deps.confirm(deps.share.name || deps.share.email)) return { kind: "cancelled" };
	const result = await deps.remove(deps.calendarId, deps.share.id);
	if (!result.ok) return { kind: "failed", status: result.status, code: result.code };
	return { kind: result.self ? "self" : "removed" };
}
