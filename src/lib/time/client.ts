"use client";

import { clearUserTimeZoneCache } from "./utils";

export const USER_TIME_ZONE_CHANGED_EVENT = "mailflare:user-time-zone-changed";

export function saveUserTimeZonePreference(userId: string, timeZone: string | null): void {
	const next = JSON.stringify({ userId, timeZone });
	try {
		if (localStorage.getItem("mailflare-user-time-zone") === next) return;
		localStorage.setItem("mailflare-user-time-zone", next);
	} catch { /* Saving on the server remains authoritative. */ }
	clearUserTimeZoneCache();
	window.dispatchEvent(new Event(USER_TIME_ZONE_CHANGED_EVENT));
}

export function clearUserTimeZonePreference(): void {
	try { localStorage.removeItem("mailflare-user-time-zone"); }
	catch { /* Storage is optional. */ }
	clearUserTimeZoneCache();
}
