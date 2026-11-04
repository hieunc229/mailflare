import type { CalendarRepeat } from "@/lib/calendar/types";

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
  excludedOccurrences: string;
  reminderMinutes?: number | null;
  timeZone?: string | null;
  seriesStartsAt?: string;
};

export type CalendarView = "week" | "day";

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
