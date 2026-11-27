"use client";

import type { DragEvent } from "react";
import toast from "react-hot-toast";
import type { Translator } from "@/lib/i18n/utils";
import type { DriveItemDto } from "@/lib/drive/types";
import { canEditDrive } from "@/lib/drive/utils";
import { attachmentAction, bulk } from "./drive-bulk-actions";
import { DRIVE_REFRESH_EVENT } from "./drive-events";

/** Marks a drag as Drive items being moved, so drop targets ignore files dragged in from the desktop. */
export const DRIVE_DRAG_TYPE = "application/x-mailflare-drive";

type DraggedItem = Pick<DriveItemDto, "id" | "kind" | "role"> & { attachment: boolean; trashed: boolean };
/**
 * Where items are dropped: a folder (`null` is the root of My Drive), the trash, or the attachments list, which only
 * takes trashed attachments back.
 */
export type DriveDropTarget = { kind: "folder"; id: string | null } | { kind: "trash" } | { kind: "attachments" };

// `dataTransfer` cannot be read until the drop, so targets decide whether to accept from this instead.
let dragged: DraggedItem[] = [];

/**
 * Items that can be picked up: attachments the user may delete, and Drive items they can edit. From the trash, only what
 * the user may restore: their own items and deletable attachments.
 */
export function isDriveDraggable(item: DriveItemDto): boolean {
	if (item.source) return item.source.canDelete;
	return item.trashedAt ? item.role === "owner" : canEditDrive(item.role);
}

export function startDriveDrag(event: DragEvent, items: DriveItemDto[], label: string) {
	dragged = items.map((item) => ({ id: item.id, kind: item.kind, role: item.role, attachment: !!item.source, trashed: !!item.trashedAt }));
	event.dataTransfer.effectAllowed = "move";
	event.dataTransfer.setData(DRIVE_DRAG_TYPE, JSON.stringify(dragged.map((item) => item.id)));
	if (items.length > 1) {
		// A small "3 selected" chip instead of the browser's snapshot of a single row.
		const chip = document.createElement("div");
		chip.textContent = label;
		chip.style.cssText = "position:fixed;top:-100px;left:0;padding:6px 12px;border-radius:9999px;background:#1d4ed8;color:#fff;font:500 13px system-ui,sans-serif;white-space:nowrap";
		document.body.appendChild(chip);
		event.dataTransfer.setDragImage(chip, 12, 16);
		setTimeout(() => chip.remove(), 0);
	}
}

export function endDriveDrag() {
	dragged = [];
}

/**
 * Whether the current drag may land on a target. Anything not yet trashed may go to the trash, and trashed attachments
 * may go back to the attachments list. Moving (which also restores from the trash) is for the owner's own Drive items,
 * never attachments, and never into a folder being dragged or one inside it (`isInside` walks up from the target, for
 * callers that know the folder tree).
 */
export function canDropDrive(target: DriveDropTarget, isInside?: (folderId: string, ancestorIds: Set<string>) => boolean): boolean {
	if (!dragged.length) return false;
	if (target.kind === "trash") return dragged.some((item) => !item.trashed);
	if (target.kind === "attachments") return dragged.every((item) => item.attachment && item.trashed);
	if (dragged.some((item) => item.attachment || item.role !== "owner")) return false;
	if (target.id === null) return true;
	const folders = new Set(dragged.filter((item) => item.kind === "folder").map((item) => item.id));
	if (folders.has(target.id)) return false;
	return !isInside?.(target.id, folders);
}

/** Moves or trashes the dragged items, reports the result and asks the listing to reload. */
export async function dropDrive(target: DriveDropTarget, t: Translator): Promise<void> {
	const items = dragged;
	endDriveDrag();
	if (!items.length) return;
	const fallback = t("drive.actionFailed");
	let count: number | null = 0;
	if (target.kind === "attachments") {
		count = await attachmentAction("restore", items.map((item) => item.id), fallback);
		if (count) toast.success(t("drive.bulkRestored", { count }));
	} else if (target.kind === "trash") {
		const live = items.filter((item) => !item.trashed);
		const attachments = live.filter((item) => item.attachment).map((item) => item.id);
		const driveIds = live.filter((item) => !item.attachment).map((item) => item.id);
		for (const done of [attachments.length ? await attachmentAction("trash", attachments, fallback) : 0, driveIds.length ? await bulk({ action: "trash", ids: driveIds }, fallback) : 0]) {
			count = count === null || done === null ? null : count + done;
		}
		if (count) toast.success(t("drive.bulkTrashed", { count }));
	} else {
		count = await bulk({ action: "move", ids: items.map((item) => item.id), parentId: target.id }, fallback);
		if (count) toast.success(t(items.every((item) => item.trashed) ? "drive.bulkRestored" : "drive.bulkMoved", { count }));
	}
	window.dispatchEvent(new Event(DRIVE_REFRESH_EVENT));
}

/**
 * Drop handlers for one target; `setOver` drives its highlight. `accepts` runs on every dragover, so keep it cheap.
 * A drop that is handled stops propagating, so the page's file-upload drop zone never sees it.
 */
export function driveDropHandlers(target: DriveDropTarget, accepts: () => boolean, t: Translator, setOver: (over: boolean) => void) {
	return {
		onDragOver(event: DragEvent) {
			if (!event.dataTransfer.types.includes(DRIVE_DRAG_TYPE) || !accepts()) return;
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = "move";
			setOver(true);
		},
		onDragLeave(event: DragEvent) {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
		},
		onDrop(event: DragEvent) {
			if (!event.dataTransfer.types.includes(DRIVE_DRAG_TYPE)) return;
			event.preventDefault();
			event.stopPropagation();
			setOver(false);
			if (accepts()) void dropDrive(target, t);
		},
	};
}
