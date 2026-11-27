"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { Room, RoomForm } from "./types";
import { formFromRoom, NEW_ROOM_FORM, roomBody } from "./utils";

export type RoomDialogProps = {
	/** The room being edited, "new" while adding one, null when closed. */
	target: Room | "new" | null;
	saving: boolean;
	/** Translated reason the last save was refused, or "". */
	error: string;
	onSave: (body: NonNullable<ReturnType<typeof roomBody>>, id: string | null) => void;
	onClose: () => void;
};

export function RoomFields({ target, saving, error, onSave, onClose }: Omit<RoomDialogProps, "target"> & { target: Room | "new" }) {
	const { t } = useLanguage();
	const [form, setForm] = useState<RoomForm>(() => (target === "new" ? NEW_ROOM_FORM : formFromRoom(target)));
	const body = roomBody(form);
	const set = <K extends keyof RoomForm>(key: K, value: RoomForm[K]) => setForm((current) => ({ ...current, [key]: value }));
	return (
		<form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (body && !saving) onSave(body, target === "new" ? null : target.id); }}>
			<div className="space-y-2">
				<Label htmlFor="room-name">{t("rooms.name")}</Label>
				<Input id="room-name" value={form.name} maxLength={120} required onChange={(event) => set("name", event.target.value)} />
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="room-kind">{t("rooms.kind")}</Label>
					<Select id="room-kind" value={form.kind} onChange={(event) => set("kind", event.target.value as Room["kind"])}>
						<option value="room">{t("rooms.kind.room")}</option>
						<option value="equipment">{t("rooms.kind.equipment")}</option>
					</Select>
				</div>
				<div className="space-y-2">
					<Label htmlFor="room-capacity">{t("rooms.capacity")}</Label>
					<Input id="room-capacity" inputMode="numeric" value={form.capacity} aria-invalid={body ? undefined : form.capacity.trim() ? true : undefined} onChange={(event) => set("capacity", event.target.value)} />
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="room-location">{t("rooms.location")}</Label>
				<Input id="room-location" value={form.location} maxLength={200} placeholder={t("rooms.locationPlaceholder")} onChange={(event) => set("location", event.target.value)} />
			</div>
			<div className="space-y-2">
				<Label htmlFor="room-description">{t("rooms.description")}</Label>
				<Textarea id="room-description" value={form.description} maxLength={1000} rows={3} onChange={(event) => set("description", event.target.value)} />
			</div>
			<div className="flex items-start gap-3">
				<Switch id="room-disabled" checked={form.disabled} onCheckedChange={(value) => set("disabled", value)} aria-describedby="room-disabled-hint" />
				<span className="min-w-0">
					<Label htmlFor="room-disabled">{t("rooms.disabled")}</Label>
					<span id="room-disabled-hint" className="block text-sm text-neutral-600">{t("rooms.disabledHint")}</span>
				</span>
			</div>
			{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
				<Button type="submit" disabled={!body || saving}>{saving ? t("common.saving") : target === "new" ? t("rooms.create") : t("rooms.save")}</Button>
			</div>
		</form>
	);
}

/** The add and edit form. The fields are remounted per room, so each opening starts from that room's values. */
export function RoomDialog({ target, ...rest }: RoomDialogProps) {
	const { t } = useLanguage();
	return (
		<Dialog open={target !== null} onOpenChange={(open) => { if (!open && !rest.saving) rest.onClose(); }}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{target === "new" || target === null ? t("rooms.addTitle") : t("rooms.editTitle", { name: target.name })}</DialogTitle>
					<DialogDescription className="sr-only">{t("rooms.intro")}</DialogDescription>
				</DialogHeader>
				{target !== null && <RoomFields key={target === "new" ? "new" : target.id} target={target} {...rest} />}
			</DialogContent>
		</Dialog>
	);
}
