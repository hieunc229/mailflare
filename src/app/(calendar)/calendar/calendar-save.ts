import { authFetch } from "@/lib/auth/client";
import type { CalendarSummary } from "@/lib/calendar/calendars-types";

export type CalendarFields = { name: string; color: string; description: string };
export type SaveResult = { ok: true; calendar: CalendarSummary; unchanged?: false } | { ok: true; calendar: CalendarSummary; unchanged: true } | { ok: false; status: number };

/**
 * Creates a calendar (everything is sent) or edits one (only what changed). Sending only changes means saving never writes back
 * the palette colour the dialog shows in place of a colour a phone set outside it, and an unnamed default calendar stays unnamed.
 */
export async function saveCalendar(calendar: CalendarSummary | null, fields: CalendarFields): Promise<SaveResult> {
	const name = fields.name.trim();
	const payload = calendar
		? { ...(name && name !== (calendar.name ?? "") ? { name } : {}), ...(fields.color !== calendar.color ? { color: fields.color } : {}), ...(fields.description.trim() !== calendar.description ? { description: fields.description } : {}) }
		: { name, color: fields.color, description: fields.description };
	if (calendar && Object.keys(payload).length === 0) return { ok: true, calendar, unchanged: true };
	try {
		const response = await authFetch(calendar ? `/api/calendar/calendars/${encodeURIComponent(calendar.id)}` : "/api/calendar/calendars", { method: calendar ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
		if (!response.ok) return { ok: false, status: response.status };
		const body = await response.json() as { calendar: CalendarSummary };
		return { ok: true, calendar: body.calendar };
	} catch { return { ok: false, status: 0 }; }
}
