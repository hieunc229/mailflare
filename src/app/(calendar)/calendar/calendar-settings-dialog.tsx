"use client";

import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { Loader2, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/auth/client";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLOR_OPTIONS } from "@/lib/folders/colors";
import { folderColorKeys } from "@/lib/folders/color-keys";
import type { CalendarSummary } from "@/lib/calendar/calendars-types";
import { calendarErrorKey, nextColor } from "./calendar-list-utils";
import { saveCalendar } from "./calendar-save";
import { calendarChanged, closeCalendarSettings, useCalendarState } from "./calendar-state";

const COLOR_VALUES = FOLDER_COLOR_OPTIONS.map((option) => option.value);

/** One tab stop for the group; arrow keys, Home and End move the choice and the focus, as for any radio group. */
function ColorChoice({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
	const { t } = useLanguage();
	const refs = useRef(new Map<string, HTMLButtonElement>());
	const selected = COLOR_VALUES.includes(value as never) ? value : COLOR_VALUES[0];
	return (
		<div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-2"
			onKeyDown={(event) => {
				const next = nextColor(COLOR_VALUES, selected, event.key);
				if (!next) return;
				event.preventDefault();
				onChange(next);
				refs.current.get(next)?.focus();
			}}>
			{FOLDER_COLOR_OPTIONS.map((option) => (
				<button key={option.value} ref={(node) => { if (node) refs.current.set(option.value, node); }} type="button" role="radio" tabIndex={selected === option.value ? 0 : -1} aria-checked={value === option.value} aria-label={t(folderColorKeys[option.value])} title={t(folderColorKeys[option.value])} onClick={() => onChange(option.value)}
					className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ${value === option.value ? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2" : "border-transparent"}`}
					style={{ backgroundColor: option.value }} />
			))}
		</div>
	);
}

/** Remounted per target (keyed by the caller), so its fields start from the calendar being edited. */
function SettingsForm({ target }: { target: CalendarSummary | "new" }) {
	const { t } = useLanguage();
	const calendar = target === "new" ? null : target;
	const [name, setName] = useState(calendar?.name ?? "");
	const [color, setColor] = useState<string>(calendar?.color ?? DEFAULT_FOLDER_COLOR);
	const [description, setDescription] = useState(calendar?.description ?? "");
	const [pending, setPending] = useState<"save" | "delete" | null>(null);
	const [error, setError] = useState("");
	// The default calendar may stay unnamed (it then shows the localised label), so an empty name is only invalid elsewhere.
	const nameOptional = calendar?.isDefault === true && !calendar.name;
	const canSave = (name.trim().length > 0 || nameOptional) && pending === null;

	async function request(url: string, init: RequestInit, action: "save" | "delete"): Promise<Record<string, unknown> | null> {
		try {
			const response = await authFetch(url, init);
			const body = await response.json().catch(() => ({})) as Record<string, unknown>;
			if (response.ok) return body;
			setError(t(calendarErrorKey(action, response.status) as never));
		} catch { setError(t(calendarErrorKey(action, 0) as never)); }
		return null;
	}

	async function save() {
		setPending("save");
		setError("");
		const result = await saveCalendar(calendar, { name, color, description });
		setPending(null);
		if (!result.ok) { setError(t(calendarErrorKey("save", result.status) as never)); return; }
		if (result.unchanged) { closeCalendarSettings(); return; }
		toast.success(t(calendar ? "calendar.calendars.saved" : "calendar.calendars.created"));
		calendarChanged(calendar ? "updated" : "created", result.calendar.id);
	}

	async function remove() {
		if (!calendar || calendar.isDefault) return;
		if (!await confirmDestructive(t("calendar.calendars.deleteConfirm", { name: calendar.name ?? "", count: calendar.eventCount }))) return;
		setPending("delete");
		setError("");
		const body = await request(`/api/calendar/calendars/${encodeURIComponent(calendar.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) }, "delete");
		setPending(null);
		if (!body) return;
		toast.success(t("calendar.calendars.deleted"));
		calendarChanged("deleted", calendar.id);
	}

	return (
		<form onSubmit={(event) => { event.preventDefault(); if (canSave) void save(); }} className="space-y-4 text-sm">
			<div>
				<label htmlFor="calendar-name" className="mb-1 block font-medium text-neutral-800">{t("calendar.calendars.name")}</label>
				<Input id="calendar-name" value={name} maxLength={100} autoFocus onChange={(event) => setName(event.target.value)} placeholder={nameOptional ? t("calendar.defaultName") : t("calendar.calendars.namePlaceholder")} />
			</div>
			<ColorChoice value={color} onChange={setColor} label={t("calendar.calendars.color")} />
			<div>
				<label htmlFor="calendar-description" className="mb-1 block font-medium text-neutral-800">{t("calendar.calendars.description")}</label>
				<Textarea id="calendar-description" value={description} maxLength={500} rows={3} onChange={(event) => setDescription(event.target.value)} />
			</div>
			{error && <p role="alert" className="text-red-700">{error}</p>}
			<div className="flex flex-wrap items-center justify-between gap-2 pt-2">
				<div>
					{calendar && !calendar.isDefault && (
						<Button type="button" variant="ghost" disabled={pending !== null} onClick={() => void remove()} className="text-red-600 hover:bg-red-50 [@media(pointer:coarse)]:min-h-11">
							{pending === "delete" ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Trash2 aria-hidden="true" className="h-4 w-4" />}{t("calendar.calendars.delete")}
						</Button>
					)}
				</div>
				<div className="flex gap-2">
					<Button type="button" variant="ghost" disabled={pending !== null} onClick={closeCalendarSettings} className="[@media(pointer:coarse)]:min-h-11">{t("common.cancel")}</Button>
					<Button type="submit" disabled={!canSave} className="[@media(pointer:coarse)]:min-h-11">{pending === "save" ? t("common.saving") : t("common.save")}</Button>
				</div>
			</div>
		</form>
	);
}

/** Mounted once in the calendar layout; every list and menu opens it through the shared store. */
export function CalendarSettingsDialog() {
	const { t } = useLanguage();
	const { settings: target } = useCalendarState();
	return (
		<Dialog open={target !== null} onOpenChange={(open) => { if (!open) closeCalendarSettings(); }}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(480px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{target === "new" ? t("calendar.calendars.new") : t("calendar.calendars.settingsTitle")}</DialogTitle>
					<DialogDescription className="sr-only">{t("calendar.calendars.settingsDescription")}</DialogDescription>
				</DialogHeader>
				{target !== null && <SettingsForm key={target === "new" ? "new" : target.id} target={target} />}
			</DialogContent>
		</Dialog>
	);
}
