"use client";

import { AlertCircle, Loader2, Plus, Settings } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { openCalendarSettings, retryCalendars, toggleCalendar, useCalendarState } from "./calendar-state";

const touch = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

/** The user's calendars with a show/hide checkbox each. Reads the shared calendar store, so every copy on screen stays in step. */
export function CalendarList() {
	const { t } = useLanguage();
	const { calendars, state, hidden } = useCalendarState();
	return (
		<section aria-labelledby="calendar-list-title" className="mb-6 border-b border-neutral-100 pb-4">
			<div className="mb-1 flex items-center justify-between gap-2">
				<h2 id="calendar-list-title" className="text-sm font-semibold text-neutral-900">{t("calendar.calendars.title")}</h2>
				<button type="button" onClick={() => openCalendarSettings("new")} aria-label={t("calendar.calendars.add")} title={t("calendar.calendars.add")}
					className={`flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 ${touch}`}><Plus aria-hidden="true" className="h-4 w-4" /></button>
			</div>
			{state === "loading" && (
				<p role="status" className="flex items-center gap-2 py-2 text-sm text-neutral-500"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("calendar.calendars.loading")}</p>
			)}
			{state === "error" && (
				<div role="alert" className="flex items-start gap-2 py-2 text-sm text-red-700">
					<AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
					<span className="min-w-0 flex-1">{t("calendar.calendars.loadFailed")}</span>
					<button type="button" onClick={retryCalendars} className={`rounded-md px-2 font-medium text-blue-700 underline hover:bg-blue-50 ${touch}`}>{t("calendar.calendars.retry")}</button>
				</div>
			)}
			{state === "ready" && (
				<ul className="space-y-0.5">
					{calendars.map((calendar) => {
						const name = calendar.name ?? t("calendar.defaultName");
						return (
							<li key={calendar.id} className="flex items-center gap-1">
								<label className={`flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-600 ${touch}`}>
									<input type="checkbox" checked={!hidden.includes(calendar.id)} onChange={() => toggleCalendar(calendar.id)} aria-label={t("calendar.calendars.show", { name })}
										style={{ accentColor: calendar.color }} className="h-4 w-4 shrink-0 cursor-pointer [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5" />
									<span className="min-w-0 flex-1 truncate">{name}</span>
								</label>
								<button type="button" onClick={() => openCalendarSettings(calendar)} aria-label={t("calendar.calendars.settings", { name })} title={t("calendar.calendars.settings", { name })}
									className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 ${touch}`}><Settings aria-hidden="true" className="h-4 w-4" /></button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
