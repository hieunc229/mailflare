"use client";

import { useState } from "react";
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
import type { CalendarSettingsDialogProps } from "./calendar-list-types";

/** Remounted per target (keyed by the caller), so its fields start from the calendar being edited. */
function SettingsForm({ target, onClose, onChanged }: CalendarSettingsDialogProps & { target: CalendarSummary | "new" }) {
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

	async function request(url: string, init: RequestInit, fallback: string): Promise<Record<string, unknown> | null> {
		try {
			const response = await authFetch(url, init);
			const body = await response.json().catch(() => ({})) as Record<string, unknown>;
			if (response.ok) return body;
			setError(typeof body.error === "string" ? body.error : fallback);
		} catch { setError(fallback); }
		return null;
	}

	async function save() {
		setPending("save");
		setError("");
		const payload = { ...(name.trim() ? { name: name.trim() } : {}), color, description };
		const body = await request(calendar ? `/api/calendar/calendars/${encodeURIComponent(calendar.id)}` : "/api/calendar/calendars", { method: calendar ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, t("calendar.calendars.saveFailed"));
		setPending(null);
		if (!body) return;
		toast.success(t(calendar ? "calendar.calendars.saved" : "calendar.calendars.created"));
		onChanged(calendar ? "updated" : "created", (body.calendar as CalendarSummary).id);
	}

	async function remove() {
		if (!calendar || calendar.isDefault) return;
		if (!await confirmDestructive(t("calendar.calendars.deleteConfirm", { name: calendar.name ?? "" }))) return;
		setPending("delete");
		setError("");
		const body = await request(`/api/calendar/calendars/${encodeURIComponent(calendar.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) }, t("calendar.calendars.deleteFailed"));
		setPending(null);
		if (!body) return;
		toast.success(t("calendar.calendars.deleted"));
		onChanged("deleted", calendar.id);
	}

	return (
		<form onSubmit={(event) => { event.preventDefault(); if (canSave) void save(); }} className="space-y-4 text-sm">
			<div>
				<label htmlFor="calendar-name" className="mb-1 block font-medium text-neutral-800">{t("calendar.calendars.name")}</label>
				<Input id="calendar-name" value={name} maxLength={100} autoFocus onChange={(event) => setName(event.target.value)} placeholder={nameOptional ? t("calendar.defaultName") : t("calendar.calendars.namePlaceholder")} />
			</div>
			<div role="radiogroup" aria-label={t("calendar.calendars.color")} className="flex flex-wrap items-center gap-2">
				{FOLDER_COLOR_OPTIONS.map((option) => (
					<button key={option.value} type="button" role="radio" aria-checked={color === option.value} aria-label={t(folderColorKeys[option.value])} title={t(folderColorKeys[option.value])} onClick={() => setColor(option.value)}
						className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ${color === option.value ? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2" : "border-transparent"}`}
						style={{ backgroundColor: option.value }} />
				))}
			</div>
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
					<Button type="button" variant="ghost" disabled={pending !== null} onClick={onClose} className="[@media(pointer:coarse)]:min-h-11">{t("common.cancel")}</Button>
					<Button type="submit" disabled={!canSave} className="[@media(pointer:coarse)]:min-h-11">{pending === "save" ? t("common.saving") : t("common.save")}</Button>
				</div>
			</div>
		</form>
	);
}

export function CalendarSettingsDialog({ target, onClose, onChanged }: CalendarSettingsDialogProps) {
	const { t } = useLanguage();
	return (
		<Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(480px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{target === "new" ? t("calendar.calendars.new") : t("calendar.calendars.settingsTitle")}</DialogTitle>
					<DialogDescription className="sr-only">{t("calendar.calendars.settingsDescription")}</DialogDescription>
				</DialogHeader>
				{target !== null && <SettingsForm key={target === "new" ? "new" : target.id} target={target} onClose={onClose} onChanged={onChanged} />}
			</DialogContent>
		</Dialog>
	);
}
