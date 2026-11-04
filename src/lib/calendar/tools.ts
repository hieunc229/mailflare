import { and, eq, gte, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { toolEmailSchema } from "@/lib/agent/schema-utils";
import { newId } from "@/lib/ids";
import { normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";
import { normalizeCalendarColor } from "./colors";
import { DEFAULT_REPEAT_DAYS, normalizeCalendarRepeatDays, parseCalendarOccurrenceId } from "./recurrence";
import { expandToolEvents } from "./tool-occurrences";
import { CONFIRMED_CALENDAR_TOOLS, createCalendarConfirmation } from "./confirmation";
import type { CalendarToolContext, CalendarToolName } from "./tool-types";

const id = z.string().min(1).max(160);
const instant = z.string().datetime({ offset: true });
const range = { start: instant, end: instant };
const repeat = z.enum(["none", "daily", "weekly", "monthly", "weekdays"]);
const fields = {
	title: z.string().trim().min(1).max(500), description: z.string().max(10_000), location: z.string().max(500),
	startsAt: instant, endsAt: instant, timeZone: z.string().max(80), color: z.string().max(30),
	repeat, repeatDays: z.array(z.number().int().min(0).max(6)).max(7), attendees: z.array(toolEmailSchema).max(50),
};
const update = z.object({ eventId: id, title: fields.title.optional(), description: fields.description.optional(), location: fields.location.optional(), startsAt: instant.optional(), endsAt: instant.optional(), timeZone: fields.timeZone.optional(), color: fields.color.optional(), repeat: repeat.optional(), repeatDays: fields.repeatDays.optional(), attendees: fields.attendees.optional() });

export const calendarToolSchemas = {
	get_schedule: z.object({ ...range }),
	search_events: z.object({ query: z.string().trim().min(1).max(300), ...range, limit: z.number().int().min(1).max(100).default(50) }),
	get_event: z.object({ eventId: id }),
	create_event: z.object({ title: fields.title, startsAt: instant, endsAt: instant, description: fields.description.optional(), location: fields.location.optional(), timeZone: fields.timeZone.optional(), color: fields.color.optional(), repeat: repeat.default("none"), repeatDays: fields.repeatDays.optional(), attendees: fields.attendees.optional() }),
	update_events: z.object({ updates: z.array(update).min(1).max(20) }),
	delete_events: z.object({ eventIds: z.array(id).min(1).max(20) }),
	find_free_time: z.object({ ...range, durationMinutes: z.number().int().min(5).max(1_440), limit: z.number().int().min(1).max(30).default(10) }),
	get_calendars: z.object({}),
} as const;

export const calendarToolDescriptions: Record<CalendarToolName, string> = {
	get_schedule: "List the user's calendar events and recurring occurrences in an ISO 8601 time range, up to 90 days.",
	search_events: "Search event title, description, and location in an ISO 8601 time range, up to 90 days.",
	get_event: "Get an event or recurring occurrence by ID. Returns its series ID for edits.",
	create_event: "Create an event in the user's personal calendar. This saves immediately; attendees are recorded but invitations are not sent.",
	update_events: "Propose changes to up to 20 owned event series by series ID. Nothing changes until the user approves it at the returned reviewUrl in Mailflare; changes apply to whole series and no invitations are sent.",
	delete_events: "Propose deleting up to 20 owned event series by series ID. Nothing is deleted until the user approves it at the returned reviewUrl in Mailflare; no cancellations are sent.",
	find_free_time: "Find available slots using the user's events in an ISO 8601 time range, up to 90 days. Returns UTC instants.",
	get_calendars: "List the calendars available here. Mailflare currently has one personal calendar per user.",
};

export const CALENDAR_TOOL_NAMES = Object.keys(calendarToolSchemas) as CalendarToolName[];
export const calendarToolScope = (name: CalendarToolName) => name === "create_event" || name === "update_events" || name === "delete_events" ? "mcp:calendar-write" : "mcp:calendar-read";

function dates(start: string, end: string) {
	const from = new Date(start);
	const to = new Date(end);
	if (to <= from || to.getTime() - from.getTime() > 90 * 86_400_000) throw new Error("Choose a positive range of at most 90 days");
	return { from, to };
}

async function eventsInRange(context: CalendarToolContext, from: Date, to: Date) {
	return getDb(context.env).select().from(calendarEvents).where(and(eq(calendarEvents.userId, context.user.id), lt(calendarEvents.startsAt, to), or(gte(calendarEvents.endsAt, from), ne(calendarEvents.repeat, "none"))));
}

export async function runCalendarTool(context: CalendarToolContext, name: CalendarToolName, rawInput: unknown): Promise<unknown> {
	const input = calendarToolSchemas[name].parse(rawInput) as Record<string, unknown>;
	const db = getDb(context.env);
	// Editing or deleting events is only proposed by an assistant; the user approves it in the app.
	if (CONFIRMED_CALENDAR_TOOLS.has(name) && !context.confirmed) {
		const token = await createCalendarConfirmation(context.env, context.user.id, name, rawInput);
		const count = ((input.updates ?? input.eventIds) as unknown[]).length;
		return {
			status: "confirmation_required",
			message: `${count} event series would be ${name === "delete_events" ? "deleted" : "changed"}. Nothing happened yet: ask the user to review and approve it in Mailflare.`,
			reviewUrl: `/agent/calendar-review?token=${encodeURIComponent(token)}`,
			expiresInMinutes: 15,
		};
	}
	if (name === "get_calendars") return { calendars: [{ id: "personal", name: "Personal calendar", timeZone: normalizeTimeZone(context.user.timeZone), writable: true }] };
	if (name === "get_schedule" || name === "search_events" || name === "find_free_time") {
		const { from, to } = dates(input.start as string, input.end as string);
		const events = expandToolEvents(await eventsInRange(context, from, to), from, to);
		if (name === "get_schedule") return { events, truncated: events.length >= 500 };
		if (name === "search_events") {
			const query = (input.query as string).toLocaleLowerCase();
			const matches = events.filter((event) => [event.title, event.description, event.location].some((value) => value.toLocaleLowerCase().includes(query)));
			return { events: matches.slice(0, input.limit as number), truncated: events.length >= 500 || matches.length > (input.limit as number) };
		}
		const duration = (input.durationMinutes as number) * 60_000;
		const busy = events.map((event) => ({ start: Math.max(from.getTime(), Date.parse(event.startsAt)), end: Math.min(to.getTime(), Date.parse(event.endsAt)) })).sort((a, b) => a.start - b.start);
		const slots: Array<{ startsAt: string; endsAt: string }> = [];
		let cursor = from.getTime();
		for (const block of [...busy, { start: to.getTime(), end: to.getTime() }]) {
			if (block.start - cursor >= duration) slots.push({ startsAt: new Date(cursor).toISOString(), endsAt: new Date(block.start).toISOString() });
			cursor = Math.max(cursor, block.end);
			if (slots.length >= (input.limit as number)) break;
		}
		return { slots, truncated: events.length >= 500 };
	}
	if (name === "get_event") {
		const occurrence = parseCalendarOccurrenceId(input.eventId as string);
		const [event] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.userId, context.user.id), eq(calendarEvents.id, occurrence?.seriesId ?? input.eventId as string))).limit(1);
		if (!event) throw new Error("Event not found");
		if (!occurrence) return { event };
		const found = expandToolEvents([event], occurrence.startsAt, new Date(occurrence.startsAt.getTime() + 1)).find((item) => item.id === input.eventId);
		if (!found) throw new Error("Occurrence not found");
		return { event: found };
	}
	if (name === "create_event") {
		const startsAt = new Date(input.startsAt as string);
		const endsAt = new Date(input.endsAt as string);
		if (endsAt <= startsAt) throw new Error("Event end must be after its start");
		const timeZone = normalizeTimeZone(input.timeZone as string ?? context.timeZone ?? context.user.timeZone);
		const repeatDays = normalizeCalendarRepeatDays(input.repeatDays ?? DEFAULT_REPEAT_DAYS);
		if (input.repeat === "weekdays" && !repeatDays.length) throw new Error("Choose at least one weekday");
		const event = { id: newId("evt"), userId: context.user.id, title: input.title as string, startsAt, endsAt, description: input.description as string ?? "", location: input.location as string ?? "", timeZone, color: normalizeCalendarColor(input.color as string | undefined), repeat: input.repeat as "none" | "daily" | "weekly" | "monthly" | "weekdays", repeatDays: JSON.stringify(repeatDays), attendees: JSON.stringify(input.attendees ?? []), repeatAnchorDay: input.repeat === "monthly" ? zonedDateFields(startsAt, timeZone).getUTCDate() : null };
		await db.insert(calendarEvents).values(event);
		return { eventId: event.id, status: "created" };
	}
	if (name === "update_events") {
		const updates = input.updates as z.infer<typeof update>[];
		const ids = updates.map((item) => item.eventId);
		if (new Set(ids).size !== ids.length || ids.some((value) => parseCalendarOccurrenceId(value))) throw new Error("Use unique series IDs for updates");
		const existing = await Promise.all(ids.map(async (eventId) => (await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, context.user.id))).limit(1))[0]));
		if (existing.some((row) => !row)) throw new Error("Event not found");
		for (const [index, item] of updates.entries()) {
			const row = existing[index]!;
			if ((item.endsAt ? new Date(item.endsAt) : row.endsAt) <= (item.startsAt ? new Date(item.startsAt) : row.startsAt)) throw new Error("Event end must be after its start");
			if ((item.repeat ?? row.repeat) === "weekdays" && !normalizeCalendarRepeatDays(item.repeatDays ?? JSON.parse(row.repeatDays)).length) throw new Error("Choose at least one weekday");
		}
		for (const [index, item] of updates.entries()) {
			const row = existing[index]!;
			const startsAt = item.startsAt ? new Date(item.startsAt) : row.startsAt;
			const endsAt = item.endsAt ? new Date(item.endsAt) : row.endsAt;
			const timeZone = item.timeZone ? normalizeTimeZone(item.timeZone) : normalizeTimeZone(row.timeZone);
			await db.update(calendarEvents).set({ title: item.title ?? row.title, description: item.description ?? row.description, location: item.location ?? row.location, startsAt, endsAt, timeZone, color: item.color ? normalizeCalendarColor(item.color) : row.color, repeat: item.repeat ?? row.repeat, repeatDays: item.repeatDays ? JSON.stringify(normalizeCalendarRepeatDays(item.repeatDays)) : row.repeatDays, repeatAnchorDay: (item.repeat ?? row.repeat) === "monthly" ? zonedDateFields(startsAt, timeZone).getUTCDate() : null, attendees: item.attendees ? JSON.stringify(item.attendees) : row.attendees, updatedAt: new Date() }).where(and(eq(calendarEvents.id, row.id), eq(calendarEvents.userId, context.user.id)));
		}
		return { eventIds: ids, status: "updated" };
	}
	const ids = input.eventIds as string[];
	if (new Set(ids).size !== ids.length || ids.some((value) => parseCalendarOccurrenceId(value))) throw new Error("Use unique series IDs for deletion");
	const existing = await Promise.all(ids.map(async (eventId) => (await db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, context.user.id))).limit(1))[0]));
	if (existing.some((row) => !row)) throw new Error("Event not found");
	for (const eventId of ids) await db.delete(calendarEvents).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, context.user.id)));
	return { eventIds: ids, status: "deleted" };
}
