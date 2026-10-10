"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import toast, { Toaster } from "react-hot-toast";
import { AlignLeft, CalendarPlus2, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, MapPin, MoreVertical, Palette, Plus, Repeat2, Trash2, UsersRound, X } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RouteLoadingBarPortal } from "@/components/route-loading-bar-portal";
import { authFetch } from "@/lib/auth/client";
import { formatUserDate, getUserTimeZone, parseUserDateTimeLocal } from "@/lib/time/utils";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { DEFAULT_REPEAT_DAYS, parseCalendarRepeatDays } from "@/lib/calendar/recurrence";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLOR_OPTIONS } from "@/lib/folders/colors";
import type { TranslationKey } from "@/lib/i18n/types";
import type { CalendarRepeat } from "@/lib/calendar/types";
import { useLanguage } from "@/components/language-provider";
import { folderColorKeys } from "@/lib/folders/color-keys";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useSidebar } from "@/components/sidebar-state";
import { UpcomingSidebar } from "../upcoming-sidebar";
import { DayEvents } from "./day-events";
import type { CalendarEvent, CalendarView, EventDragPreview, EventResizeEdge, EventResizeSession } from "./types";
import {
  addDays, addMonths, calendarAnchorDay, CALENDAR_END_HOUR, CALENDAR_HOUR_HEIGHT, CALENDAR_START_HOUR,
  currentTimePosition, dateKey, defaultCalendarStart, dropStartForPosition, EVENT_COLOR_CLASSES, eventEndAfterMinutes, eventPosition, expandCalendarEvents,
  formatEventRange, formatHour, formatLocalDateTime,
  monthGridDates, PAST_EVENT_COLOR_CLASSES, rescheduleCalendarOccurrence, resizeEventTimes, startOfDay, startOfMonth, startOfWeek, WEEKDAY_OPTIONS,
} from "./utils";
import clsx from "clsx";

const eventFieldClass = "h-9 border-transparent bg-transparent px-2 shadow-none hover:bg-white/60 focus:border-blue-600 focus:bg-white focus:shadow-sm";

export default function CalendarPage() {
  const { t } = useLanguage();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsVersion, setEventsVersion] = useState(0);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [visibleDate, setVisibleDate] = useState(() => new Date());
  const [view, setView] = useState<CalendarView>("week");
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [pickerMonth, setPickerMonth] = useState(() => new Date());
  const monthPickerRef = useRef<HTMLDivElement | null>(null);
  const monthPickerPopupRef = useRef<HTMLDivElement | null>(null);
  const [monthPickerPos, setMonthPickerPos] = useState<{ top: number; left: number } | null>(null);
  const openedEventFromUrl = useRef<string | null>(null);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [draggedEvent, setDraggedEvent] = useState<CalendarEvent | null>(null);
  const [resizingEvent, setResizingEvent] = useState<CalendarEvent | null>(null);
  const [dragPreview, setDragPreview] = useState<EventDragPreview | null>(null);
  const dragOffsetPixels = useRef(0);
  const resizeSession = useRef<EventResizeSession | null>(null);
  const [title, setTitle] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_FOLDER_COLOR);
  const [repeat, setRepeat] = useState<CalendarRepeat>("none");
  const [repeatDays, setRepeatDays] = useState<number[]>(DEFAULT_REPEAT_DAYS);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [durationOptionsOpen, setDurationOptionsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [closingEventEditor, setClosingEventEditor] = useState(false);
  const [guests, setGuests] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [pendingAction, setPendingAction] = useState<"save" | string | null>(null);
  const router = useRouter();
  const eventFromUrl = useSearchParams().get("event");
  const { selectedMailbox } = useSelectedMailbox();
  const { minimal: sidebarMinimal, mobile } = useSidebar();
  const minimal = sidebarMinimal || mobile;

  const now = new Date(currentTime);
  const todayTime = startOfDay(now).getTime();
  const today = useMemo(() => new Date(todayTime), [todayTime]);
  const weekStart = useMemo(() => startOfWeek(visibleDate), [visibleDate]);
  const days = useMemo(
    () => view === "day" ? [startOfDay(visibleDate)] : Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [view, visibleDate, weekStart],
  );
  const pickerDates = useMemo(() => monthGridDates(pickerMonth), [pickerMonth]);
  const previewEvent = useMemo(() => dragPreview && (draggedEvent || resizingEvent)
    ? {
      ...(draggedEvent || resizingEvent)!,
      startsAt: dragPreview.startsAt.toISOString(),
      endsAt: dragPreview.endsAt.toISOString(),
    }
    : null, [dragPreview, draggedEvent, resizingEvent]);
  const previewPosition = useMemo(() => dragPreview && previewEvent
    ? eventPosition(previewEvent, dragPreview.day)
    : null, [dragPreview, previewEvent]);

  useEffect(() => {
    setHeaderTarget(document.getElementById("calendar-header-slot"));
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!monthPickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!monthPickerRef.current?.contains(target) && !monthPickerPopupRef.current?.contains(target)) setMonthPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMonthPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [monthPickerOpen]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const start = new Date(Math.min(today.getTime(), weekStart.getTime(), startOfDay(visibleDate).getTime()));
    const end = new Date(Math.max(addDays(today, 90).getTime(), addDays(weekStart, 7).getTime(), addDays(visibleDate, 1).getTime()));
    void authFetch(`/api/calendar/events?start=${start.toISOString()}&end=${end.toISOString()}`)
      .then((response) => {
        if (!response.ok) throw new Error(t("calendar.loadFailed"));
        return response.json();
      })
      .then((data) => { if (active) setEvents(expandCalendarEvents(data.events ?? [], start, end)); })
      .catch(() => { if (active) toast.error(t("calendar.loadFailed")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [today, visibleDate, weekStart, eventsVersion, t]);

  useEffect(() => {
    if (!eventFromUrl) { openedEventFromUrl.current = null; return; }
    if (openedEventFromUrl.current === eventFromUrl) return;
    const event = events.find((item) => item.id === eventFromUrl);
    if (!event) return;
    openedEventFromUrl.current = eventFromUrl;
    editEvent(event);
    // Drop the param so picking the same event again re-opens it.
    router.replace("/calendar");
  }, [events, eventFromUrl]);

  function openNewEvent(day = visibleDate, startAt?: Date) {
    const start = startAt ? new Date(startAt) : defaultCalendarStart(day);
    setEditing(null);
    setTitle("");
    setColor(DEFAULT_FOLDER_COLOR);
    setRepeat("none");
    setRepeatDays(DEFAULT_REPEAT_DAYS);
    setGuests("");
    setLocation("");
    setDescription("");
    setStartsAt(formatLocalDateTime(start));
    setEndsAt(formatLocalDateTime(new Date(start.getTime() + 60 * 60_000)));
    setDurationOptionsOpen(false);
    setClosingEventEditor(false);
    setAdding(true);
  }

  async function addEvent() {
    setPendingAction("save");
    try {
      const editedStart = editing && startsAt === formatLocalDateTime(new Date(editing.startsAt)) ? new Date(editing.startsAt) : parseUserDateTimeLocal(startsAt);
      const editedEnd = editing && endsAt === formatLocalDateTime(new Date(editing.endsAt)) ? new Date(editing.endsAt) : parseUserDateTimeLocal(endsAt);
      if (!editedStart || !editedEnd || editedEnd <= editedStart) { toast.error(t("calendar.invalidTimes")); return; }
      const movingToPast = Boolean(editing && editing.repeat !== "none" && editedStart.getTime() < Date.now() && editedStart.getTime() !== new Date(editing.startsAt).getTime());
      const effectiveFrom = editing && editing.repeat !== "none" && !movingToPast ? new Date() : null;
      let savedStart = editedStart;
      let savedEnd = editedEnd;
      if (editing && effectiveFrom) {
        const next = rescheduleCalendarOccurrence(editing, editedStart, editedEnd, effectiveFrom);
        if (!next) { toast.error(t("calendar.noFuture")); return; }
        savedStart = next.startsAt;
        savedEnd = next.endsAt;
      }
      const repeatAnchorDay = editing?.repeat === "monthly" && startsAt.slice(0, 10) === formatLocalDateTime(new Date(editing.startsAt)).slice(0, 10)
        ? editing.repeatAnchorDay ?? calendarAnchorDay(editing, new Date(editing.seriesStartsAt ?? editing.startsAt))
        : calendarAnchorDay(editing, editedStart);
      const response = await authFetch(editing ? `/api/calendar/events/${editing.id}` : "/api/calendar/events", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title, startsAt: savedStart.toISOString(), endsAt: savedEnd.toISOString(), color, repeat, repeatDays, repeatAnchorDay, effectiveFrom: effectiveFrom?.toISOString(), moveOccurrenceToPast: movingToPast, attendees: guests.split(","),
          timeZone: getUserTimeZone(),
          description,
          location,
          mailboxId: selectedMailbox?.id,
          from: selectedMailbox?.senderAddresses?.[0] ??
            (selectedMailbox ? `${selectedMailbox.localPart}@${selectedMailbox.hostname}` : ""),
        }),
      });
      if (response.ok) {
        setEventsVersion((version) => version + 1);
        setClosingEventEditor(true);
      } else {
        const result = await response.json();
        toast.error(result.error ?? t("calendar.saveFailed"));
      }
    } catch {
      toast.error(t("calendar.saveFailed"));
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteEvent(id: string) {
    const recurring = editing && editing.repeat !== "none";
    if (!window.confirm(recurring ? t("calendar.deleteFuture") : t("calendar.deleteEvent"))) return;
    setPendingAction(id);
    try {
      const effectiveFrom = recurring ? new Date().toISOString() : undefined;
      const response = await authFetch(`/api/calendar/events/${id}`, { method: "DELETE", headers: effectiveFrom ? { "Content-Type": "application/json" } : undefined, body: effectiveFrom ? JSON.stringify({ effectiveFrom }) : undefined });
      if (response.ok) {
        setEventsVersion((version) => version + 1);
        setClosingEventEditor(true);
      } else {
        const result = await response.json();
        toast.error(result.error ?? t("calendar.deleteFailed"));
      }
    } catch {
      toast.error(t("calendar.deleteFailed"));
    } finally {
      setPendingAction(null);
    }
  }

  function editEvent(event: CalendarEvent) {
    setEditing(event);
    setTitle(event.title);
    setColor(normalizeCalendarColor(event.color));
    setRepeat(event.repeat);
    setRepeatDays(event.repeat === "weekdays" ? parseCalendarRepeatDays(event.repeatDays) : DEFAULT_REPEAT_DAYS);
    setLocation(event.location ?? "");
    setDescription(event.description ?? "");
    setStartsAt(formatLocalDateTime(new Date(event.startsAt)));
    setEndsAt(formatLocalDateTime(new Date(event.endsAt)));
    setDurationOptionsOpen(false);
    setGuests(JSON.parse(event.attendees || "[]").join(", "));
    setClosingEventEditor(false);
    setAdding(true);
  }

  async function saveEventTimes(event: CalendarEvent, startsAt: Date, endsAt: Date) {
    if (startsAt.getTime() === new Date(event.startsAt).getTime() && endsAt.getTime() === new Date(event.endsAt).getTime()) {
      setDraggedEvent(null);
      setResizingEvent(null);
      setDragPreview(null);
      return;
    }
    setPendingAction(event.id);
    // Non-recurring events move in place right away; the refetch below confirms.
    const previousEvents = event.repeat === "none" ? events : null;
    if (previousEvents) {
      setEvents((current) => current.map((item) => item.id === event.id ? { ...item, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } : item));
    }
    let saved = false;
    try {
      const movingToPast = event.repeat !== "none" && startsAt.getTime() < Date.now();
      const effectiveFrom = event.repeat !== "none" && !movingToPast ? new Date() : null;
      let savedStart = startsAt;
      let savedEnd = endsAt;
      if (effectiveFrom) {
        const next = rescheduleCalendarOccurrence(event, startsAt, endsAt, effectiveFrom);
        if (!next) { toast.error(t("calendar.noFuture")); return; }
        savedStart = next.startsAt;
        savedEnd = next.endsAt;
      }
      const response = await authFetch(`/api/calendar/events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: event.title,
          description: event.description,
          location: event.location,
          attendees: JSON.parse(event.attendees || "[]"),
          color: event.color,
          repeat: event.repeat,
          repeatDays: parseCalendarRepeatDays(event.repeatDays),
          timeZone: getUserTimeZone(),
          repeatAnchorDay: event.repeat === "monthly" && dateKey(startsAt) === dateKey(new Date(event.startsAt))
            ? event.repeatAnchorDay ?? calendarAnchorDay(event, new Date(event.seriesStartsAt ?? event.startsAt))
            : calendarAnchorDay(event, startsAt),
          effectiveFrom: effectiveFrom?.toISOString(),
          moveOccurrenceToPast: movingToPast,
          startsAt: savedStart.toISOString(),
          endsAt: savedEnd.toISOString(),
          from: selectedMailbox?.senderAddresses?.[0] ??
            (selectedMailbox ? `${selectedMailbox.localPart}@${selectedMailbox.hostname}` : ""),
        }),
      });
      if (!response.ok) {
        toast.error(t("calendar.updateTimeFailed"));
        return;
      }
      saved = true;
      setEventsVersion((version) => version + 1);
    } catch {
      toast.error(t("calendar.updateTimeFailed"));
    } finally {
      if (previousEvents && !saved) setEvents(previousEvents);
      setDraggedEvent(null);
      setResizingEvent(null);
      setDragPreview(null);
      setPendingAction(null);
    }
  }

  function moveEvent(event: CalendarEvent, day: Date, pixelsFromTop: number) {
    const startsAt = dropStartForPosition(day, pixelsFromTop);
    const endsAt = new Date(startsAt.getTime() + new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime());
    void saveEventTimes(event, startsAt, endsAt);
  }

  function startResize(pointerEvent: ReactPointerEvent<HTMLButtonElement>, event: CalendarEvent, day: Date, edge: EventResizeEdge) {
    if (pendingAction !== null) return;
    const column = pointerEvent.currentTarget.parentElement;
    if (!column) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
    resizeSession.current = { event, day, edge, columnTop: column.getBoundingClientRect().top, pointerY: pointerEvent.clientY, moved: false };
    setResizingEvent(event);
    setDragPreview({ eventId: event.id, day, startsAt: new Date(event.startsAt), endsAt: new Date(event.endsAt) });
  }

  function updateResize(pointerEvent: ReactPointerEvent<HTMLButtonElement>) {
    const session = resizeSession.current;
    if (!session) return;
    if (Math.abs(pointerEvent.clientY - session.pointerY) < 3) return;
    session.moved = true;
    const times = resizeEventTimes(session.event, session.day, session.edge, pointerEvent.clientY - session.columnTop);
    // Times snap to 15 minutes, so most pointer moves change nothing.
    setDragPreview((current) => current && current.startsAt.getTime() === times.startsAt.getTime() && current.endsAt.getTime() === times.endsAt.getTime()
      ? current
      : { eventId: session.event.id, day: session.day, startsAt: times.startsAt, endsAt: times.endsAt });
  }

  function finishResize(pointerEvent: ReactPointerEvent<HTMLButtonElement>) {
    const session = resizeSession.current;
    if (!session) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    resizeSession.current = null;
    if (!session.moved) {
      setResizingEvent(null);
      setDragPreview(null);
      return;
    }
    const times = resizeEventTimes(session.event, session.day, session.edge, pointerEvent.clientY - session.columnTop);
    void saveEventTimes(session.event, times.startsAt, times.endsAt);
  }

  function cancelResize() {
    resizeSession.current = null;
    setResizingEvent(null);
    setDragPreview(null);
  }

  const handlers = useRef({ editEvent, startResize, updateResize, finishResize, cancelResize });
  handlers.current = { editEvent, startResize, updateResize, finishResize, cancelResize };
  const onEditEvent = useCallback((event: CalendarEvent) => handlers.current.editEvent(event), []);
  const onResizeStart = useCallback((pointerEvent: ReactPointerEvent<HTMLButtonElement>, event: CalendarEvent, day: Date, edge: EventResizeEdge) => handlers.current.startResize(pointerEvent, event, day, edge), []);
  const onResizeMove = useCallback((pointerEvent: ReactPointerEvent<HTMLButtonElement>) => handlers.current.updateResize(pointerEvent), []);
  const onResizeEnd = useCallback((pointerEvent: ReactPointerEvent<HTMLButtonElement>) => handlers.current.finishResize(pointerEvent), []);
  const onResizeCancel = useCallback(() => handlers.current.cancelResize(), []);
  const onEventDragStart = useCallback((dragEvent: DragEvent<HTMLButtonElement>, event: CalendarEvent) => {
    dragOffsetPixels.current = dragEvent.clientY - dragEvent.currentTarget.getBoundingClientRect().top;
    dragEvent.dataTransfer.setData("text/plain", event.id);
    dragEvent.dataTransfer.effectAllowed = "move";
    setDraggedEvent(event);
  }, []);
  const onEventDragEnd = useCallback(() => { setDraggedEvent(null); setDragPreview(null); }, []);
  const busy = pendingAction !== null;
  const activeEventId = draggedEvent?.id ?? resizingEvent?.id ?? null;

  return (
    <div className={clsx("flex h-full min-h-0 flex-col bg-[#f6f8fc] pl-3 max-md:pl-0 lg:flex-row transition-[gap] duration-200 ease-in-out motion-reduce:transition-none", minimal ? "gap-0" : "gap-3")}>
      <Toaster position="bottom-left" />
      <h1 className="sr-only">{t("account.calendar")}</h1>
      {loading && <RouteLoadingBarPortal />}
      {headerTarget && createPortal(
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 ">
          <div className="flex shrink-0 items-center gap-2">
          <div ref={monthPickerRef} className="relative shrink-0">
            <button type="button" onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMonthPickerPos({ top: rect.bottom + 12, left: Math.max(12, Math.min(rect.left, window.innerWidth - 460)) });
              setPickerMonth(startOfMonth(visibleDate));
              setMonthPickerOpen((open) => !open);
            }} className="flex items-center gap-2 whitespace-nowrap text-lg font-semibold text-neutral-900 max-md:text-base max-md:font-medium" aria-haspopup="dialog" aria-expanded={monthPickerOpen}>
              {formatUserDate(visibleDate, { month: "long", year: "numeric" })}
              <ChevronDown className="h-5 w-5 text-neutral-500" />
            </button>
            {monthPickerOpen && monthPickerPos && createPortal(
              <div ref={monthPickerPopupRef} role="dialog" aria-label={t("calendar.chooseDate")} style={monthPickerPos} className="fixed z-50 w-[448px] max-w-[calc(100vw-24px)] rounded-2xl bg-[#f7f9fc] p-5 shadow-xl ring-1 ring-neutral-200/70">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold text-neutral-900">
                    {formatUserDate(pickerMonth, { month: "long", year: "numeric" })}
                  </h2>
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label={t("calendar.previousMonth")} onClick={() => setPickerMonth(addMonths(pickerMonth, -1))} className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200/70">
                      <ChevronLeft className="h-6 w-6" />
                    </button>
                    <button type="button" aria-label={t("calendar.nextMonth")} onClick={() => setPickerMonth(addMonths(pickerMonth, 1))} className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200/70">
                      <ChevronRight className="h-6 w-6" />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-7">
                  {([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => (
                    <span key={weekday} aria-label={t(`weekday.${weekday}`)} className="flex h-10 items-center justify-center text-sm font-medium text-neutral-500">{t(`weekday.${weekday}`).charAt(0).toUpperCase()}</span>
                  ))}
                  {pickerDates.map((day) => {
                    const selected = dateKey(day) === dateKey(visibleDate);
                    const isToday = dateKey(day) === dateKey(today);
                    const outsideMonth = dateKey(day).slice(0, 7) !== dateKey(pickerMonth).slice(0, 7);
                    return (
                      <button key={dateKey(day)} type="button" aria-label={formatUserDate(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} aria-pressed={selected}
                        onClick={() => { setVisibleDate(day); setMonthPickerOpen(false); }}
                        className={clsx("mx-auto my-0.5 flex h-11 w-11 items-center justify-center rounded-full text-base font-medium hover:bg-neutral-200/80",
                          selected ? "bg-blue-600 text-white hover:bg-blue-600" : isToday ? "bg-neutral-200 text-neutral-900" : outsideMonth ? "text-neutral-500" : "text-neutral-900")}>
                        {formatUserDate(day, { day: "numeric" })}
                      </button>
                    );
                  })}
                </div>
              </div>,
              document.body,
            )}
          </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" aria-label={t(view === "week" ? "calendar.previousView.week" : "calendar.previousView.day")} onClick={() => setVisibleDate(addDays(visibleDate, view === "week" ? -7 : -1))} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-white"><ChevronLeft className="h-6 w-6" /></button>
            <button type="button" aria-label={t(view === "week" ? "calendar.nextView.week" : "calendar.nextView.day")} onClick={() => setVisibleDate(addDays(visibleDate, view === "week" ? 7 : 1))} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-white"><ChevronRight className="h-6 w-6" /></button>
            <button type="button" onClick={() => setVisibleDate(new Date())} className="h-10 rounded-full max-md:hidden bg-white px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50">{t("calendar.today")}</button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" aria-label={t("calendar.options")} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-white md:hidden"><MoreVertical className="h-5 w-5" /></button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4} className="z-[130] min-w-40 rounded-xl border border-neutral-200 bg-white p-1 text-sm shadow-xl md:hidden">
                  <DropdownMenu.Item onSelect={() => setVisibleDate(new Date())} className="cursor-pointer rounded-lg px-3 py-2 text-neutral-700 outline-none data-[highlighted]:bg-neutral-100">{t("calendar.today")}</DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
                  {(["week", "day"] as const).map((option) => <DropdownMenu.Item key={option} onSelect={() => setView(option)} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-neutral-700 outline-none data-[highlighted]:bg-neutral-100">{option === "week" ? t("calendar.week") : t("calendar.day")}{view === option && <Check className="h-4 w-4 text-blue-600" />}</DropdownMenu.Item>)}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <div className="relative max-md:hidden">
              <select value={view} onChange={(event) => setView(event.target.value as CalendarView)} aria-label={t("calendar.view")} className="h-10 appearance-none rounded-full border-0 bg-white pl-4 pr-10 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
                <option value="week">{t("calendar.week")}</option>
                <option value="day">{t("calendar.day")}</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-neutral-600" />
            </div>
            <Button disabled={pendingAction !== null} onClick={() => openNewEvent()} className={clsx("ml-1 max-md:ml-0 h-10 rounded-full bg-blue-600 px-4 text-white hover:bg-blue-500", mobilePrimaryActionClass)}><Plus className="h-5 w-5" />{t("calendar.newEvent")}</Button>
          </div>
        </div>,
        headerTarget,
      )}
      <UpcomingSidebar events={events} onSelect={editEvent} />

      <section aria-busy={loading} className="min-h-0 min-w-0 flex-1 rounded-t-3xl bg-white flex flex-col overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
          <div className={clsx("w-full", view === "week" ? "min-w-190" : "min-w-90")}>
            <div className="sticky top-0 z-30 grid h-14 border-b border-neutral-200 bg-white" style={{ gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` }}>
              <div />
              {days.map((day) => (
                <div key={dateKey(day)} className={`border-l border-neutral-100 px-3 py-2 text-xs ${dateKey(day) === dateKey(today) ? "text-blue-700" : "text-neutral-700"}`}>
                  {formatUserDate(day, { weekday: "short" })}
                  <span className="text-2xl block font-medium">
                    {formatUserDate(day, { day: "numeric" })}
                  </span>
                </div>
              ))}
            </div>
          <div className="grid" style={{ gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))`, height: (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * CALENDAR_HOUR_HEIGHT }}>
            <div className="relative">
              {Array.from({ length: CALENDAR_END_HOUR - CALENDAR_START_HOUR }, (_, index) => (
                <span key={index} className={`absolute right-3 text-xs text-neutral-700 ${index === 0 ? "" : "-translate-y-1/2"}`} style={{ top: index * CALENDAR_HOUR_HEIGHT }}>{index % 2 == 0 ? null : formatHour(CALENDAR_START_HOUR + index)}</span>
              ))}
            </div>
            {days.map((day) => (
              <div key={dateKey(day)} className={"relative border-l border-neutral-100"}
                onDragOver={(event) => {
                  if (!draggedEvent) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const start = dropStartForPosition(day, event.clientY - event.currentTarget.getBoundingClientRect().top - dragOffsetPixels.current);
                  const end = new Date(start.getTime() + new Date(draggedEvent.endsAt).getTime() - new Date(draggedEvent.startsAt).getTime());
                  setDragPreview((current) => current?.eventId === draggedEvent.id && dateKey(current.day) === dateKey(day) && current.startsAt.getTime() === start.getTime()
                    ? current : { eventId: draggedEvent.id, day, startsAt: start, endsAt: end });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedEvent) void moveEvent(draggedEvent, day, event.clientY - event.currentTarget.getBoundingClientRect().top - dragOffsetPixels.current);
                }}
                style={{ backgroundImage: "linear-gradient(to bottom, transparent calc(100% - 1px), var(--color-neutral-100) calc(100% - 1px))", backgroundSize: `100% ${CALENDAR_HOUR_HEIGHT}px` }}>
                <button type="button" aria-label={t("calendar.addEventOn", { date: formatUserDate(day, { dateStyle: "short" }) })} onClick={(event) => openNewEvent(day, dropStartForPosition(day, event.nativeEvent.offsetY))} className="absolute inset-0 z-0 cursor-crosshair" />
                <DayEvents day={day} events={events} currentTime={currentTime} busy={busy} activeEventId={activeEventId}
                  onEdit={onEditEvent} onDragStart={onEventDragStart} onDragEnd={onEventDragEnd}
                  onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} onResizeCancel={onResizeCancel} />
                {dragPreview && previewEvent && previewPosition && dateKey(dragPreview.day) === dateKey(day) && (
                  <div className={`pointer-events-none absolute left-1 right-1 z-20 rounded-lg border-2 border-dashed border-white ${new Date(previewEvent.endsAt).getTime() <= currentTime ? PAST_EVENT_COLOR_CLASSES[normalizeCalendarColor(previewEvent.color)] : EVENT_COLOR_CLASSES[normalizeCalendarColor(previewEvent.color)]}`}
                    style={{ top: previewPosition.top, height: previewPosition.height }}>
                    <span className="absolute left-1 top-0 z-10 whitespace-nowrap rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {formatEventRange(previewEvent)}
                    </span>
                    {previewPosition.height >= 50 && <span className="block truncate px-2 pt-6 text-[12px] font-semibold">{previewEvent.title}</span>}
                  </div>
                )}
                {dateKey(day) === dateKey(now) && (
                  <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-30" style={{ top: currentTimePosition(now) }}>
                    <div className="h-1 w-full bg-blue-600" />
                    <div className="absolute -left-2.5 -top-2 h-5 w-5 rounded-full bg-blue-600" />
                  </div>
                )}
              </div>
            ))}
          </div>
          </div>
        </div>
      </section>

      {adding && (
        <div className={clsx("dialog-overlay fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/35 p-4", closingEventEditor && "pointer-events-none")} data-state={closingEventEditor ? "closed" : "open"}>
          <div role="dialog" aria-modal="true" aria-label={editing ? t("calendar.editEvent") : t("calendar.createEvent")} className="dialog-content max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6" data-state={closingEventEditor ? "closed" : "open"}
            onAnimationEnd={(event) => {
              if (!closingEventEditor || event.target !== event.currentTarget) return;
              setAdding(false);
              setEditing(null);
              setClosingEventEditor(false);
            }}>
            <div className="flex items-start gap-3">
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("calendar.addTitle")} aria-label={t("calendar.eventName")}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-2xl font-medium text-neutral-900 outline-none placeholder:text-neutral-500 hover:bg-white/60 focus:border-blue-600 focus:bg-white" />
              <button type="button" aria-label={t("calendar.closeEditor")} disabled={pendingAction === "save"} onClick={() => setClosingEventEditor(true)} className="shrink-0 rounded-full p-1 text-neutral-600 hover:bg-neutral-200 disabled:opacity-50"><X className="h-5 w-5" /></button>
            </div>
            <div className="mt-4 space-y-2">
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-3">
                <Clock3 aria-hidden="true" className="mt-2 h-5 w-5 text-neutral-600" />
                <div className="min-w-0" onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setDurationOptionsOpen(false);
                }}>
                  <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] sm:gap-2">
                    <label className="relative block min-w-0 text-sm">
                      <span className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 font-medium text-neutral-500">{t("calendar.from")}</span>
                      <Input type="datetime-local" value={startsAt} onFocus={() => setDurationOptionsOpen(true)} onChange={(event) => setStartsAt(event.target.value)} aria-label={t("calendar.fromLabel")} className={`${eventFieldClass} pl-14`} />
                    </label>
                    <div aria-hidden="true" className="h-px w-full self-center bg-neutral-200 sm:h-6 sm:w-px" />
                    <label className="relative block min-w-0 text-sm">
                      <span className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 font-medium text-neutral-500">{t("calendar.to")}</span>
                      <Input type="datetime-local" value={endsAt} onFocus={() => setDurationOptionsOpen(true)} onChange={(event) => setEndsAt(event.target.value)} aria-label={t("calendar.toLabel")} className={`${eventFieldClass} pl-14`} />
                    </label>
                  </div>
                  {durationOptionsOpen && <div className="flex flex-wrap gap-1 pt-1" aria-label={t("calendar.setDuration")}>
                    {([15, 30, 60, 1440] as const).map((minutes) => ({ minutes, label: t(`calendar.dur.${minutes}`) })).map((preset) => (
                      <Button key={preset.minutes} type="button" variant="ghost" disabled={!parseUserDateTimeLocal(startsAt)} onClick={() => { setEndsAt(eventEndAfterMinutes(startsAt, preset.minutes)); setDurationOptionsOpen(false); }} className="h-7 rounded-full px-2 text-xs text-neutral-600 hover:bg-neutral-100">
                        {preset.label}
                      </Button>
                    ))}
                  </div>}
                </div>
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-3">
                <Repeat2 aria-hidden="true" className="mt-2 h-5 w-5 text-neutral-600" />
                <div className="min-w-0">
                  <div className="relative">
                    <select value={repeat} onChange={(event) => setRepeat(event.target.value as CalendarRepeat)} aria-label={t("calendar.repeat")}
                    className="h-9 w-full appearance-none rounded-md border border-transparent bg-transparent pl-2 pr-8 text-sm text-neutral-700 outline-none hover:bg-neutral-50 focus:border-blue-600 focus:bg-white">
                    <option value="none">{t("calendar.repeat.none")}</option>
                    <option value="daily">{t("calendar.repeat.daily")}</option>
                    <option value="weekly">{t("calendar.repeat.weekly")}</option>
                    <option value="monthly">{t("calendar.repeat.monthly")}</option>
                    <option value="weekdays">{t("calendar.repeat.weekdays")}</option>
                    </select>
                    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                  </div>
                  {repeat === "weekdays" && (
                    <div role="group" aria-label={t("calendar.repeatOnWeekdays")} className="flex flex-wrap gap-1.5 px-2 pt-1">
                      {WEEKDAY_OPTIONS.map((day) => (
                        <button key={day.value} type="button" aria-label={t("calendar.repeatOn", { day: t(`weekday.${day.value}` as TranslationKey) })} aria-pressed={repeatDays.includes(day.value)}
                          onClick={() => setRepeatDays((selected) => selected.includes(day.value) ? selected.filter((value) => value !== day.value) : [...selected, day.value].sort((a, b) => a - b))}
                          className={clsx("rounded-full px-2.5 py-1 text-xs font-medium", repeatDays.includes(day.value) ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")}>
                          {t(`calendar.weekdayShort.${day.value}` as TranslationKey)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-3">
                <UsersRound aria-hidden="true" className="h-5 w-5 text-neutral-600" />
                <Input value={guests} onChange={(event) => setGuests(event.target.value)} placeholder={t("calendar.addGuests")} aria-label={t("calendar.guestsLabel")} className={eventFieldClass} />
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-3">
                <MapPin aria-hidden="true" className="h-5 w-5 text-neutral-600" />
                <Input value={location} onChange={(event) => setLocation(event.target.value)} placeholder={t("calendar.addLocation")} aria-label={t("calendar.location")} className={eventFieldClass} />
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-3">
                <AlignLeft aria-hidden="true" className="mt-2 h-5 w-5 text-neutral-600" />
                <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("calendar.addDescription")} aria-label={t("calendar.description")} rows={Math.max(1, description.split("\n").length)} className={clsx("min-h-9 border-transparent bg-transparent px-2 py-2 shadow-none hover:bg-white/60 focus:min-h-24 focus:resize-y focus:border-blue-600 focus:bg-white focus-visible:ring-0", description ? "min-h-24 resize-y" : "resize-none")} />
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-3">
                <Palette aria-hidden="true" className="h-5 w-5 text-neutral-600" />
                <div role="radiogroup" aria-label={t("calendar.eventColor")} className="flex flex-wrap items-center gap-1.5 px-2">
                  {FOLDER_COLOR_OPTIONS.map((option) => (
                    <button key={option.value} type="button" role="radio" aria-label={t(folderColorKeys[option.value])} title={t(folderColorKeys[option.value])} aria-checked={color === option.value} onClick={() => setColor(option.value)}
                      className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${color === option.value ? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2" : "border-transparent"}`}
                      style={{ backgroundColor: option.value }} />
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 pt-6">
                <div />
                <div className="flex justify-between gap-2">
                  <div>{editing && <Button variant="ghost" disabled={pendingAction !== null} onClick={() => void deleteEvent(editing.id)} className="px-2 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" />{t("common.delete")}</Button>}</div>
                  <Button onClick={() => void addEvent()} disabled={!title.trim() || !parseUserDateTimeLocal(startsAt) || !parseUserDateTimeLocal(endsAt) || parseUserDateTimeLocal(endsAt)! <= parseUserDateTimeLocal(startsAt)! || (repeat === "weekdays" && repeatDays.length === 0) || pendingAction === "save"} className="rounded-full bg-blue-600 px-6 text-white hover:bg-blue-700">
                    {pendingAction === "save" ? t("common.saving") : t("settings.autoReply.save")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
