import type { CalendarRepeat } from "@/lib/calendar/types";
import type { CalendarRole } from "@/lib/calendar/shares-types";

export type CalendarEvent = {
  id: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  location: string;
  attendees: string;
  color: string;
  repeat: CalendarRepeat;
  repeatDays: string;
  repeatAnchorDay: number | null;
  repeatUntil: string | null;
  /** Step between recurrences: every N days/weeks/months/years. */
  repeatInterval?: number | null;
  /** Weekday (0-6) and week (1-5, -1 = last) of an nth-weekday monthly repeat. */
  repeatWeekday?: number | null;
  repeatWeek?: number | null;
  /** RFC 5545 rule of a custom repeat (set in another app); present exactly when `repeat` is "custom". */
  rrule?: string | null;
  excludedOccurrences: string;
  reminderMinutes?: number | null;
  /** CLASS:PRIVATE: only the owner (and, later, editors) see the details. */
  isPrivate?: boolean;
  /** Shown as free: the event does not make its owner busy. */
  transparent?: boolean;
  /** The calendar the event is in (the default calendar's id when it has none of its own). */
  calendarId?: string;
  /** The CalDAV series this row belongs to: its own id for a series made by a CalDAV client, the master's for a moved occurrence. */
  davObjectId?: string | null;
  /** The owner of the calendar the event is in: the viewer's own id for their own events. */
  userId?: string;
  /** What the viewer may do with it: "owner" for their own events, else the role they were granted on its calendar. */
  role?: CalendarRole;
  /** The server hid the details (a private event, or a free/busy view): `title` is a placeholder to translate. */
  redacted?: boolean;
  timeZone?: string | null;
  seriesStartsAt?: string;
  /** Set on events created from an emailed invitation: needs-action (pending), tentative or accepted. */
  responseStatus?: string | null;
  inviteMessageId?: string | null;
  /** JSON map of guest address to accepted, tentative or declined. */
  attendeeResponses?: string | null;
  /** The rooms the event is booked for, accepted or declined (only for events the viewer may read in full). */
  rooms?: { resourceId: string; status: "accepted" | "declined"; conflictAt: string | null }[];
  /** Set on a booking drawn from a room's schedule: the room, not a calendar, it belongs to. */
  roomId?: string;
};

export type CalendarView = "month" | "week" | "day";

export type CalendarEventTimes = { startsAt: Date; endsAt: Date };

export type EventGroup = {
  key: string;
  label: string;
  events: CalendarEvent[];
};

export type EventDragPreview = {
  eventId: string;
  day: Date;
  startsAt: Date;
  endsAt: Date;
};

export type EventResizeEdge = "start" | "end";

export type EventResizeSession = {
  event: CalendarEvent;
  day: Date;
  edge: EventResizeEdge;
  columnTop: number;
  pointerY: number;
  moved: boolean;
};
