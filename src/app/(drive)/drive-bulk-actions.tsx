"use client";

import { useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import { Folder, FolderInput, FolderPlus, HardDrive, RotateCcw, Trash2, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import type { DriveItemDto } from "@/lib/drive/types";

type FolderNode = { id: string; name: string; parentId: string | null };
type FolderRow = FolderNode & { depth: number; disabled: boolean };

export async function bulk(body: Record<string, unknown>, fallback: string): Promise<number | null> {
	try {
		const response = await authFetch("/api/drive/items/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const data = await response.json().catch(() => ({})) as { count?: number; error?: string };
		if (!response.ok) throw new Error(data.error);
		return data.count ?? 0;
	} catch (error) {
		toast.error(error instanceof Error && error.message ? error.message : fallback);
		return null;
	}
}

export async function attachmentAction(action: "trash" | "restore" | "delete", ids: string[], fallback: string): Promise<number | null> {
	try {
		const response = await authFetch("/api/drive/attachments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ids }) });
		const data = await response.json().catch(() => ({})) as { count?: number; error?: string };
		if (!response.ok) throw new Error(data.error);
		return data.count ?? 0;
	} catch (error) {
		toast.error(error instanceof Error && error.message ? error.message : fallback);
		return null;
	}
}

/** Flattens the folder list depth-first. Folders being moved, and everything beneath them, cannot be targets. */
function buildRows(folders: FolderNode[], moving: Set<string>): FolderRow[] {
	const children = new Map<string | null, FolderNode[]>();
	const known = new Set(folders.map((folder) => folder.id));
	for (const folder of folders) {
		const key = folder.parentId && known.has(folder.parentId) ? folder.parentId : null;
		children.set(key, [...(children.get(key) ?? []), folder]);
	}
	const rows: FolderRow[] = [];
	const visit = (parent: string | null, depth: number, blocked: boolean) => {
		for (const folder of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))) {
			const disabled = blocked || moving.has(folder.id);
			rows.push({ ...folder, depth, disabled });
			visit(folder.id, depth + 1, disabled);
		}
	};
	visit(null, 0, false);
	return rows;
}

export function DriveBulkActions({ selected, trashView, onDone }: { selected: DriveItemDto[]; trashView: boolean; onDone: () => void }) {
	const { t } = useLanguage();
	const [folders, setFolders] = useState<FolderNode[] | null>(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const ids = useMemo(() => selected.map((item) => item.id), [selected]);
	const rows = useMemo(() => buildRows(folders ?? [], new Set(ids)), [folders, ids]);
	const driveIds = useMemo(() => selected.filter((item) => !item.source).map((item) => item.id), [selected]);
	const attachmentIds = useMemo(() => selected.filter((item) => item.source).map((item) => item.id), [selected]);
	// Editors can trash what is shared with them; moving, restoring and deleting forever are for the owner.
	const driveItems = selected.filter((item) => !item.source);
	const ownsAll = driveItems.every((item) => item.role === "owner");
	const canTrash = driveItems.every((item) => item.role === "owner" || item.role === "edit");
	const count = selected.length;

	async function run(task: () => Promise<number | null>, message: (count: number) => string) {
		setBusy(true);
		const done = await task();
		setBusy(false);
		if (done === null) return;
		toast.success(message(done));
		onDone();
	}

	/** Applies a trash action to the Drive items and the email attachments in the selection. */
	async function act(action: "trash" | "restore" | "delete"): Promise<number | null> {
		let total = 0;
		if (driveIds.length) {
			const done = await bulk({ action, ids: driveIds }, t("drive.actionFailed"));
			if (done === null) return null;
			total += done;
		}
		if (attachmentIds.length) {
			const done = await attachmentAction(action, attachmentIds, t("drive.actionFailed"));
			if (done === null) return null;
			total += done;
		}
		return total;
	}

	async function loadFolders(open: boolean) {
		if (!open) return;
		setName("");
		try {
			const response = await authFetch("/api/drive/folders");
			if (!response.ok) throw new Error();
			setFolders((await response.json() as { folders: FolderNode[] }).folders);
		} catch { toast.error(t("drive.loadFailed")); }
	}

	const move = (parentId: string | null) => run(() => bulk({ action: "move", ids, parentId }, t("drive.actionFailed")), (done) => t("drive.bulkMoved", { count: done }));

	async function createAndMove(event: React.FormEvent) {
		event.preventDefault();
		const folderName = name.trim();
		if (!folderName) return;
		setBusy(true);
		try {
			const response = await authFetch("/api/drive/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: folderName }) });
			const data = await response.json().catch(() => ({})) as { item?: { id: string }; error?: string };
			if (!response.ok || !data.item) throw new Error(data.error);
			setBusy(false);
			await move(data.item.id);
		} catch (error) {
			setBusy(false);
			toast.error(error instanceof Error && error.message ? error.message : t("drive.actionFailed"));
		}
	}

	const buttonClass = "h-9 gap-2 rounded-full px-3 text-sm";
	return (
		<div className="flex flex-wrap items-center justify-end gap-1 text-sm">
			{!trashView && canTrash && (
				<>
					<Button type="button" variant="ghost" className={buttonClass} disabled={busy} onClick={() => void run(() => act("trash"), (done) => t("drive.bulkTrashed", { count: done }))}><Trash2 size={16} />{t("drive.moveToTrash")}</Button>
					{attachmentIds.length === 0 && ownsAll && <DropdownMenu.Root onOpenChange={(open) => void loadFolders(open)}>
						<DropdownMenu.Trigger asChild>
							<Button type="button" variant="ghost" className={buttonClass} disabled={busy}><FolderInput size={16} />{t("drive.moveToFolder")}</Button>
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content align="end" sideOffset={6} onCloseAutoFocus={(event) => event.preventDefault()} className="z-[200] w-72 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl">
								<form onSubmit={(event) => void createAndMove(event)} onKeyDown={(event) => event.stopPropagation()} className="flex items-center gap-1 border-b border-neutral-100 p-1.5 pb-2">
									<FolderPlus size={16} className="shrink-0 text-neutral-500" />
									<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={255} placeholder={t("drive.newFolderPlaceholder")} aria-label={t("drive.newFolderPlaceholder")} className="h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-transparent px-2 text-sm placeholder:text-neutral-500 focus:border-blue-600 focus:outline-none" />
									<Button type="submit" size="sm" disabled={busy || !name.trim()} title={t("drive.createAndMove")}>{t("drive.create")}</Button>
								</form>
								<div className="max-h-64 overflow-y-auto pt-1">
									<DropdownMenu.Item onSelect={() => void move(null)} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100"><HardDrive size={16} className="shrink-0" />{t("drive.myDrive")}</DropdownMenu.Item>
									{rows.map((folder) => (
										<DropdownMenu.Item key={folder.id} disabled={folder.disabled} onSelect={() => void move(folder.id)} style={{ paddingLeft: 10 + folder.depth * 14 }} className={clsx("flex cursor-pointer items-center gap-2 rounded-lg py-2 pr-2.5 text-sm text-neutral-700 outline-none data-[disabled]:cursor-default data-[disabled]:opacity-40 data-[highlighted]:bg-neutral-100")}>
											<Folder size={16} className="shrink-0 text-amber-500" /><span className="truncate">{folder.name}</span>
										</DropdownMenu.Item>
									))}
									{folders && rows.length === 0 && <p className="px-2.5 py-2 text-xs text-neutral-500">{t("drive.noFolders")}</p>}
								</div>
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>}
				</>
			)}
			{ownsAll && trashView && (
				<>
					<Button type="button" variant="ghost" className={buttonClass} disabled={busy} onClick={() => void run(() => act("restore"), (done) => t("drive.bulkRestored", { count: done }))}><RotateCcw size={16} />{t("drive.restore")}</Button>
					<Button type="button" variant="ghost" className={clsx(buttonClass, "text-red-600")} disabled={busy} onClick={() => { if (window.confirm(t("drive.confirmBulkDelete", { count }))) void run(() => act("delete"), (done) => t("drive.bulkDeleted", { count: done })); }}><X size={16} />{t("drive.deleteForever")}</Button>
				</>
			)}
		</div>
	);
}
