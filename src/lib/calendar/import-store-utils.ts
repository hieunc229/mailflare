import { isIcsAddress } from "./ics";
import type { ImportEvent, ImportGroup } from "./ics-import-types";
import type { CalendarImportPlan, CalendarImportRow, ImportGroupIds, PlannedGroup } from "./import-store-types";
import { inviteEventId } from "./invite-store";

/** 4 rows x 19 bound columns = 76 parameters, under D1's limit of 100. */
export const ROWS_PER_INSERT = 4;
/** `id IN (...)` plus the user id: 91 parameters. */
export const SELECT_CHUNK = 90;
export const STATEMENTS_PER_BATCH = 50;

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}

/** The row id of one imported event: stable for (user, UID, occurrence), so a re-import finds it again. */
export async function icsEventId(userId: string, uid: string, recurrenceMs: number | null): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}\n${uid}\n${recurrenceMs ?? ""}`));
	return `ics_${[...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function planGroupIds(userId: string, group: ImportGroup): Promise<ImportGroupIds> {
	const ownId = group.uid.endsWith("@mailflare") && group.uid.length > "@mailflare".length ? group.uid.slice(0, -"@mailflare".length) : null;
	return {
		incId: await inviteEventId(userId, group.uid),
		ownId,
		masterId: group.master ? await icsEventId(userId, group.uid, null) : null,
		overrideIds: await Promise.all(group.overrides.map((override) => icsEventId(userId, group.uid, override.recurrenceId!.getTime()))),
	};
}

/** Every id whose presence on the calendar matters for these groups. */
export function candidateIds(planned: PlannedGroup[]): string[] {
	const ids = new Set<string>();
	for (const { ids: group } of planned) {
		ids.add(group.incId);
		if (group.ownId) ids.add(group.ownId);
		if (group.masterId) ids.add(group.masterId);
		for (const id of group.overrideIds) ids.add(id);
	}
	return [...ids];
}

function toRow(id: string, userId: string, color: string, event: ImportEvent): CalendarImportRow {
	return {
		id, userId, mailboxId: null,
		title: event.title, description: event.description, location: event.location,
		attendees: JSON.stringify(event.attendees), color,
		repeat: event.repeat, repeatDays: JSON.stringify(event.repeatDays), repeatAnchorDay: event.repeatAnchorDay, repeatUntil: event.repeatUntil,
		excludedOccurrences: JSON.stringify(event.excluded.map((date) => date.getTime())),
		timeZone: event.timeZone, startsAt: event.startsAt, endsAt: event.endsAt, reminderMinutes: event.reminderMinutes,
	};
}

/**
 * Decides which events to insert. A UID that already arrived as an emailed invitation, or names one of the user's own
 * Mailflare events, is skipped whole. Otherwise each event is skipped on its own when its import id exists, so an
 * import that stopped half way finishes on the next run. Imported rows carry no mailbox, invitation sender or response
 * status: later edits never email anyone and mail can never change them.
 */
export function planCalendarImportRows(planned: PlannedGroup[], existing: Set<string>, userId: string, color: string): CalendarImportPlan {
	const plan: CalendarImportPlan = { rows: [], imported: 0, skipped: 0, simplified: 0, guessedZone: 0 };
	const seen = new Set<string>();
	for (const { group, ids } of planned) {
		const events = [...(group.master && ids.masterId ? [{ id: ids.masterId, event: group.master }] : []), ...group.overrides.map((event, index) => ({ id: ids.overrideIds[index], event }))];
		plan.skipped += group.skipped;
		if (existing.has(ids.incId) || (ids.ownId && existing.has(ids.ownId))) { plan.skipped += events.length; continue; }
		let added = 0;
		for (const { id, event } of events) {
			if (existing.has(id) || seen.has(id)) { plan.skipped++; continue; }
			seen.add(id);
			plan.rows.push(toRow(id, userId, color, event));
			added++;
			if (event === group.master && group.simplified) plan.simplified++;
		}
		if (added && group.guessedZone) plan.guessedZone++;
	}
	plan.imported = plan.rows.length;
	return plan;
}

export const MAX_REQUEST_GROUPS = 50;
export const MAX_GROUP_CHARS = 512 * 1024;
/** Rows one request may insert; a UID with many overrides counts each. */
export const MAX_REQUEST_EVENTS = 1000;

export type CalendarImportBody = { name: string; color?: string; googleAddress?: string; reminders: boolean; skipDeclined: boolean; groups: string[] };

/** Checks the untrusted JSON body of POST /api/import/calendar. */
export function readCalendarImportBody(body: unknown): { value: CalendarImportBody; error?: undefined } | { error: string; value?: undefined } {
	const object = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
	const input = object(body);
	const source = object(input?.source);
	if (!input || !source) return { error: "Invalid request" };
	if (typeof source.name !== "string" || !source.name || source.name.length > 120) return { error: "Invalid calendar name" };
	const options = input.options === undefined ? {} : object(input.options);
	if (!options || (options.reminders !== undefined && typeof options.reminders !== "boolean") || (options.skipDeclined !== undefined && typeof options.skipDeclined !== "boolean")) return { error: "Invalid options" };
	const { groups } = input;
	if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_REQUEST_GROUPS) return { error: `Send 1 to ${MAX_REQUEST_GROUPS} events per request` };
	if (groups.some((group) => typeof group !== "string" || group.length > MAX_GROUP_CHARS)) return { error: "Invalid or oversized event" };
	const address = typeof source.googleAddress === "string" ? source.googleAddress.trim().toLowerCase() : "";
	return {
		value: {
			name: source.name,
			color: typeof source.color === "string" ? source.color : undefined,
			googleAddress: address.length <= 254 && isIcsAddress(address) ? address : undefined,
			reminders: options.reminders !== false,
			skipDeclined: options.skipDeclined !== false,
			groups: groups as string[],
		},
	};
}
