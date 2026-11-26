/** What a grant gives, lowest first (spec F9 D-4). The owner is not a grant. */
export type CalendarGrantRole = "freebusy" | "read" | "edit" | "manage";
export type CalendarRole = "owner" | CalendarGrantRole;

export type ShareEntry = { id: string; userId: string; name: string; email: string; role: CalendarGrantRole; createdAt: string };

export type ShareFailure = { ok: false; status: 400 | 403 | 404 | 409; error: string };
/** `ownerId` is the calendar's owner: the audit target, and the user id any event written to it carries (D-2). */
export type ShareListResult = { ok: true; ownerId: string; role: CalendarRole; shares: ShareEntry[] } | ShareFailure;
export type ShareGrantResult = { ok: true; ownerId: string; share: ShareEntry } | ShareFailure;
export type ShareChangeResult = { ok: true; ownerId: string; share: ShareEntry; previousRole: CalendarGrantRole } | ShareFailure;
export type ShareRevokeResult = { ok: true; ownerId: string; share: ShareEntry } | ShareFailure;

/** A calendar the user holds a grant on. */
export type GrantedCalendar = { id: string; ownerId: string; role: CalendarGrantRole };
