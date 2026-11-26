import { authFetch } from "@/lib/auth/client";

export type PersonAvailability = { status: "ok"; busy: string[][] } | { status: "unknown" };
export type AvailabilityResult = { ok: true; results: Record<string, PersonAvailability> } | { ok: false; status: number };

/** One call to POST /api/calendar/free-busy for the given addresses and window; `excludeEventId` is the event being edited, which should not count as busy. A failed or unreachable call is `ok: false`, never a throw. */
export async function fetchAvailability(addresses: string[], from: Date, to: Date, excludeEventId?: string): Promise<AvailabilityResult> {
	try {
		const response = await authFetch("/api/calendar/free-busy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses, start: from.toISOString(), end: to.toISOString(), ...(excludeEventId ? { excludeEventId } : {}) }) });
		if (!response.ok) return { ok: false, status: response.status };
		const body = (await response.json()) as { results?: Record<string, PersonAvailability> };
		return body.results && typeof body.results === "object" ? { ok: true, results: body.results } : { ok: false, status: 502 };
	} catch {
		return { ok: false, status: 0 };
	}
}
