"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { createPortal } from "react-dom";
import { HeaderSearch } from "@/components/header-search";
import { useRouter, useSearchParams } from "next/navigation";
import toast, { Toaster } from "react-hot-toast";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import { ArrowDown, ArrowUp, ChevronRight, Download, ExternalLink, Mail, MoreVertical, Pencil, RotateCcw, Share2, Trash2, UploadCloud, X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
import { canEditDrive, DRIVE_MAX_FILE_BYTES, formatDriveSize } from "@/lib/drive/utils";
import type { DriveItemDto } from "@/lib/drive/types";
import { DRIVE_FOLDERS_EVENT, DRIVE_NEW_FOLDER_EVENT, DRIVE_REFRESH_EVENT, DRIVE_STORAGE_EVENT, DRIVE_UPLOAD_EVENT } from "../drive-events";
import { DrivePreviewBody } from "../drive-preview";
import { DriveShareDialog } from "../drive-share-dialog";
import { driveFileUrl, driveIconFor, emailUrl, sortDriveItems } from "../drive-utils";
import type { DriveSortKey } from "../drive-utils";
import { DriveBulkActions } from "../drive-bulk-actions";
import { Checkbox } from "@/components/ui/checkbox";
import { DriveOwnerAvatar } from "../drive-owner-avatar";
import { ColumnResizeHandle, useDriveColumns } from "../drive-columns";
import { DriveTypeFilter } from "../drive-type-filter";
import { isDriveCategory } from "@/lib/drive/category-names";
import type { DriveCategory } from "@/lib/drive/category-names";
import { uploadDriveFile } from "../drive-upload";
import type { DriveUploadEntry } from "../drive-upload-types";
import { DriveUploadPanel } from "../drive-upload-panel";
import { clearDriveListings, readDriveListing, saveDriveListing } from "../drive-cache";
import type { DriveListing } from "../drive-cache";
import { Skeleton } from "@/components/ui/skeleton";
import { canDropDrive, driveDropHandlers, endDriveDrag, isDriveDraggable, startDriveDrag } from "../drive-drag";

const menuItemClass = "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100";
const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

export default function DrivePage() {
	const { t } = useLanguage();
	const router = useRouter();
	const params = useSearchParams();
	const view = params.get("view") ?? "my";
	const folder = params.get("folder");
	const query = params.get("q") ?? "";
	const typesParam = params.get("types") ?? "";
	const types = useMemo(() => typesParam.split(",").filter((entry): entry is DriveCategory => isDriveCategory(entry)), [typesParam]);
	const [listing, setListing] = useState<{ key: string; data: DriveListing } | null>(null);
	const [failedKey, setFailedKey] = useState<string | null>(null);
	const [uploads, setUploads] = useState<DriveUploadEntry[]>([]);
	const uploadSeq = useRef(0);
	const [sortKey, setSortKey] = useState<DriveSortKey>("name");
	const columns = useDriveColumns();
	const [ascending, setAscending] = useState(true);
	const [dragging, setDragging] = useState(false);
	const [search, setSearch] = useState(query);
	const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
	const [preview, setPreview] = useState<DriveItemDto | null>(null);
	const [sharing, setSharing] = useState<DriveItemDto | null>(null);
	const [naming, setNaming] = useState<{ mode: "create" | "rename"; item?: DriveItemDto; value: string } | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const selectAllRef = useRef<HTMLInputElement | null>(null);
	const fileInput = useRef<HTMLInputElement | null>(null);
	const dragDepth = useRef(0);
	// Rows being dragged to another folder or the trash, and the folder row under the pointer.
	const [movingIds, setMovingIds] = useState<Set<string>>(new Set());
	const [dropFolder, setDropFolder] = useState<string | null>(null);

	const requestKey = `${view}|${folder ?? ""}|${query}|${typesParam}`;
	// A listing seen before renders straight from memory while it is refetched; only a new one shows the skeleton.
	const current = listing?.key === requestKey ? listing.data : readDriveListing(requestKey);
	const items = useMemo(() => current?.items ?? [], [current]);
	const path = current?.path ?? [];
	const role = current?.role ?? "owner";
	const loading = !current;
	const failed = failedKey === requestKey && !current;
	const canWrite = view !== "trash" && (folder ? canEditDrive(role) : view === "my");
	// The key of the listing the page currently wants, so a slow response for a folder we already left is dropped.
	const requestRef = useRef(requestKey);
	useEffect(() => { requestRef.current = requestKey; }, [requestKey]);

	const load = useCallback(async () => {
		const key = requestKey;
		const search = new URLSearchParams({ view });
		if (folder) search.set("parent", folder);
		if (query) search.set("q", query);
		if (typesParam) search.set("types", typesParam);
		try {
			const response = await authFetch(`/api/drive/items?${search}`);
			if (!response.ok) throw new Error();
			const data = await response.json() as DriveListing;
			saveDriveListing(key, data);
			if (key !== requestRef.current) return;
			setListing({ key, data }); setFailedKey(null);
			window.dispatchEvent(new CustomEvent(DRIVE_STORAGE_EVENT, { detail: { used: data.storageUsed, limit: data.storageLimit } }));
			window.dispatchEvent(new Event(DRIVE_FOLDERS_EVENT));
		} catch {
			if (key === requestRef.current) setFailedKey(key);
		}
	}, [view, folder, query, typesParam, requestKey]);
	// Reload after a change; other cached listings may be stale now, so they are dropped.
	const refresh = useCallback(() => { clearDriveListings(); return load(); }, [load]);

	useEffect(() => { void load(); }, [load]);
	useEffect(() => { setSearch(query); }, [query]);
	useEffect(() => {
		const onRefresh = () => void refresh();
		window.addEventListener(DRIVE_REFRESH_EVENT, onRefresh);
		return () => window.removeEventListener(DRIVE_REFRESH_EVENT, onRefresh);
	}, [refresh]);
	useEffect(() => { setSelectedIds(new Set()); }, [requestKey]);
	// Keep only selected items that are still listed (after a move, trash, upload or reload).
	useEffect(() => { setSelectedIds((current) => { const present = new Set(items.map((item) => item.id)); const next = new Set([...current].filter((id) => present.has(id))); return next.size === current.size ? current : next; }); }, [items]);
	useEffect(() => { setHeaderTarget(document.getElementById("drive-header-slot")); }, []);

	const patchUpload = useCallback((id: string, patch: Partial<DriveUploadEntry>) => setUploads((list) => list.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))), []);

	const upload = useCallback(async (files: File[]) => {
		if (!canWrite || !files.length) return;
		const accepted: { id: string; file: File }[] = [];
		for (const file of files) {
			if (file.size > DRIVE_MAX_FILE_BYTES) toast.error(t("drive.tooLarge", { name: file.name, size: formatDriveSize(DRIVE_MAX_FILE_BYTES) }));
			else accepted.push({ id: `upload-${(uploadSeq.current += 1)}`, file });
		}
		if (!accepted.length) return;
		setUploads((list) => [...list, ...accepted.map(({ id, file }) => ({ id, name: file.name, percent: 0, resumed: false, status: "queued" as const }))]);
		let done = 0;
		for (const { id, file } of accepted) {
			patchUpload(id, { status: "uploading" });
			try {
				await uploadDriveFile(file, folder, (percent, resumed) => patchUpload(id, { percent, resumed }));
				done += 1;
				patchUpload(id, { status: "done", percent: 100 });
			} catch (error) {
				patchUpload(id, { status: "failed", error: error instanceof Error && error.message ? error.message : t("drive.uploadFailed", { name: file.name }) });
			}
		}
		if (done) await refresh();
	}, [canWrite, folder, refresh, patchUpload, t]);

	const canWriteRef = useRef(canWrite);
	useEffect(() => { canWriteRef.current = canWrite; }, [canWrite]);
	useEffect(() => {
		const onUpload = () => { if (canWriteRef.current) fileInput.current?.click(); };
		const onFolder = () => { if (canWriteRef.current) setNaming({ mode: "create", value: t("drive.untitledFolder") }); };
		window.addEventListener(DRIVE_UPLOAD_EVENT, onUpload);
		window.addEventListener(DRIVE_NEW_FOLDER_EVENT, onFolder);
		return () => { window.removeEventListener(DRIVE_UPLOAD_EVENT, onUpload); window.removeEventListener(DRIVE_NEW_FOLDER_EVENT, onFolder); };
	}, [t]);

	async function mutate(url: string, init: RequestInit, successMessage?: string) {
		try {
			const response = await authFetch(url, init);
			if (!response.ok) {
				const data = await response.json().catch(() => ({})) as { error?: string };
				throw new Error(data.error);
			}
			if (successMessage) toast.success(successMessage);
			await refresh();
			return true;
		} catch (error) {
			toast.error(error instanceof Error && error.message ? error.message : t("drive.actionFailed"));
			return false;
		}
	}

	const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

	async function submitName(event: React.FormEvent) {
		event.preventDefault();
		if (!naming || !naming.value.trim()) return;
		const ok = naming.mode === "create"
			? await mutate("/api/drive/items", json("POST", { name: naming.value, parentId: folder }))
			: await mutate(`/api/drive/items/${naming.item!.id}`, json("PATCH", { name: naming.value }));
		if (ok) setNaming(null);
	}

	function open(item: DriveItemDto) {
		if (item.trashedAt) return;
		if (item.kind === "folder") router.push(`/drive?folder=${encodeURIComponent(item.id)}${view === "shared" ? "&view=shared" : ""}`);
		else setPreview(item);
	}

	function onDragEnter(event: DragEvent) {
		if (!canWrite || !event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		dragDepth.current += 1;
		setDragging(true);
	}
	function onDragLeave() {
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDragging(false);
	}
	function onDrop(event: DragEvent) {
		if (!canWrite || !event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		dragDepth.current = 0;
		setDragging(false);
		void upload([...event.dataTransfer.files]);
	}

	// Dragging a selected row carries the whole selection; any other row goes alone.
	function onItemDragStart(event: DragEvent, item: DriveItemDto) {
		const group = selectedIds.has(item.id) ? selectedItems.filter(isDriveDraggable) : [item];
		startDriveDrag(event, group, t("drive.selected", { count: group.length }));
		setMovingIds(new Set(group.map((entry) => entry.id)));
	}
	function onItemDragEnd() {
		endDriveDrag();
		setMovingIds(new Set());
		setDropFolder(null);
	}

	function setTypes(next: DriveCategory[]) {
		const search = new URLSearchParams(params.toString());
		if (next.length) search.set("types", next.join(",")); else search.delete("types");
		router.push(`/drive${search.size ? `?${search}` : ""}`);
	}

	const sorted = useMemo(() => sortDriveItems(items, sortKey, ascending), [items, sortKey, ascending]);
	// Attachments can only be selected when the user may delete them.
	const selectable = sorted.filter((item) => (item.source ? item.source.canDelete : canEditDrive(item.role)));
	const selectedItems = selectable.filter((item) => selectedIds.has(item.id));
	const allSelected = selectable.length > 0 && selectedItems.length === selectable.length;
	useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = selectedItems.length > 0 && !allSelected; }, [selectedItems.length, allSelected]);
	const toggleItem = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
	const attachmentsView = view === "attachments" && !folder;
	const title = view === "attachments" ? t("drive.attachments") : view === "trash" ? t("drive.trash") : view === "shared" ? t("drive.sharedWithMe") : query ? t("drive.search") : t("drive.myDrive");
	const rootHref = view === "shared" ? "/drive?view=shared" : "/drive";
	const emptyText = view === "attachments" ? t("drive.emptyAttachments") : view === "trash" ? t("drive.emptyTrash") : view === "shared" ? t("drive.emptyShared") : query ? t("drive.emptySearch") : t("drive.empty");

	function toggleSort(key: DriveSortKey) {
		if (key === sortKey) setAscending((value) => !value);
		else { setSortKey(key); setAscending(true); }
	}
	const SortIcon = ascending ? ArrowUp : ArrowDown;
	const headerButton = (key: DriveSortKey, label: string) => (
		<button type="button" onClick={() => toggleSort(key)} className="flex min-w-0 items-center gap-1 font-medium text-neutral-600 hover:text-neutral-900"><span className="truncate">{label}</span>{sortKey === key && <SortIcon size={12} className="shrink-0" />}</button>
	);
	const gridStyle = { "--drive-columns": columns.template } as React.CSSProperties;

	return (
		<div className="relative flex h-full min-h-0 flex-col" onDragEnter={onDragEnter} onDragOver={(event) => { if (canWrite && event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDragLeave={onDragLeave} onDrop={onDrop}>
			<Toaster position="bottom-left" containerClassName="text-sm" />
			
			{headerTarget && createPortal(
				<HeaderSearch value={search} onChange={setSearch} label={t("drive.search")} onSubmit={() => router.push(search.trim() ? `/drive?q=${encodeURIComponent(search.trim())}` : "/drive")} />,
				headerTarget,
			)}
			<input ref={fileInput} type="file" multiple hidden onChange={(event) => { void upload([...(event.target.files ?? [])]); event.target.value = ""; }} />
			<div className="flex min-h-0 flex-1 flex-col rounded-t-3xl bg-white">
				<div className="flex min-h-[4.25rem] shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
					<nav aria-label={title} className="flex min-w-0 flex-wrap items-center gap-1 text-xl text-neutral-800 max-md:text-lg">
					{loading && folder ? <Skeleton className="h-7 w-48" /> : path.length === 0 ? <h1 className="font-normal">{title}</h1> : (
						<>
							<button type="button" onClick={() => router.push(rootHref)} className="rounded-full px-2 py-1 hover:bg-neutral-100">{view === "shared" || role !== "owner" ? t("drive.sharedWithMe") : t("drive.myDrive")}</button>
							{path.map((crumb, index) => (
								<span key={crumb.id} className="flex items-center gap-1">
									<ChevronRight size={18} className="text-neutral-500" />
									{index === path.length - 1 ? <h1 className="px-2 py-1 font-normal">{crumb.name}</h1> : <button type="button" onClick={() => router.push(`/drive?folder=${encodeURIComponent(crumb.id)}${view === "shared" ? "&view=shared" : ""}`)} className="rounded-full px-2 py-1 hover:bg-neutral-100">{crumb.name}</button>}
								</span>
							))}
						</>
					)}
				</nav>
					{selectedItems.length > 0 && (
						<span className="flex shrink-0 items-center gap-1 text-sm text-neutral-600">
							<button type="button" onClick={() => setSelectedIds(new Set())} aria-label={t("navigation.close")} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-neutral-100"><X size={16} /></button>
							{t("drive.selected", { count: selectedItems.length })}
						</span>
					)}
				</div>
					<div className="flex items-center gap-2">
						{selectedItems.length > 0 && <DriveBulkActions selected={selectedItems} trashView={view === "trash"} onDone={() => { setSelectedIds(new Set()); void refresh(); }} />}
						<DriveTypeFilter value={types} onChange={setTypes} />
					</div>
				</div>
				{view === "trash" && !folder && <p className="shrink-0 border-b border-neutral-200 bg-neutral-50 px-5 py-2 text-xs text-neutral-600">{t("drive.trashNotice", { days: 30 })}</p>}
				<div style={gridStyle} className="grid shrink-0 grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-center gap-x-4 border-b border-neutral-200 px-5 py-2 text-sm md:grid-cols-[var(--drive-columns)]">
					<Checkbox ref={selectAllRef} checked={allSelected} onChange={() => setSelectedIds(allSelected ? new Set() : new Set(selectable.map((item) => item.id)))} disabled={selectable.length === 0} aria-label={t("drive.selectAll")} className="ml-1" />
					<span className="min-w-0 pl-7">{headerButton("name", t("drive.name"))}</span>
					<span className="relative hidden min-w-0 md:block">{headerButton("owner", attachmentsView ? t("drive.from") : t("drive.owner"))}<ColumnResizeHandle column="owner" width={columns.widths.owner} onResize={columns.resize} label={t("drive.owner")} /></span>
					<span className="relative hidden min-w-0 md:block">{headerButton("updatedAt", t("drive.modified"))}<ColumnResizeHandle column="updatedAt" width={columns.widths.updatedAt} onResize={columns.resize} label={t("drive.modified")} /></span>
					<span className="relative hidden min-w-0 md:block">{headerButton("size", t("drive.fileSize"))}<ColumnResizeHandle column="size" width={columns.widths.size} onResize={columns.resize} label={t("drive.fileSize")} /></span>
					<span />
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 space-y-px pt-px">
					{failed ? <p className="p-8 text-center text-sm text-neutral-500">{t("drive.loadFailed")}</p>
						: loading ? Array.from({ length: 8 }, (_, index) => (
							<div key={index} aria-hidden="true" style={gridStyle} className="grid grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-center gap-x-4 px-3 py-3.5 md:grid-cols-[var(--drive-columns)]">
								<Skeleton className="ml-1 h-4 w-4" />
								<span className="flex items-center gap-3"><Skeleton className="h-4 w-4 shrink-0" /><Skeleton className="h-4" style={{ width: `${45 + ((index * 17) % 40)}%` }} /></span>
								<Skeleton className="hidden h-6 w-6 rounded-full md:block" />
								<Skeleton className="hidden h-4 w-24 md:block" />
								<Skeleton className="hidden h-4 w-14 md:block" />
								<span />
							</div>
						))
						: sorted.length === 0 ? <p className="p-12 text-center text-sm text-neutral-500">{emptyText}</p>
						: sorted.map((item) => {
							const { Icon, className } = driveIconFor(item);
							// Only the owner's own folders take drops, matching what the move endpoint allows.
							const dropTarget = item.kind === "folder" && item.role === "owner" && !item.trashedAt && !item.source
								? driveDropHandlers({ kind: "folder", id: item.id }, () => canDropDrive({ kind: "folder", id: item.id }), t, (over) => setDropFolder((current) => (over ? item.id : current === item.id ? null : current)))
								: {};
							return (
								<div key={item.id} style={gridStyle} draggable={isDriveDraggable(item)} onDragStart={(event) => onItemDragStart(event, item)} onDragEnd={onItemDragEnd} {...dropTarget} className={clsx("group grid grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-center gap-x-4 rounded-lg px-3 text-sm md:grid-cols-[var(--drive-columns)]", dropFolder === item.id ? "bg-blue-100 ring-2 ring-inset ring-blue-500" : selectedIds.has(item.id) ? "bg-blue-50" : "hover:bg-neutral-50", movingIds.has(item.id) && "opacity-50")}>
									<Checkbox checked={selectedIds.has(item.id)} onChange={() => toggleItem(item.id)} disabled={!selectable.includes(item)} aria-label={t("drive.selectItem", { name: item.name })} className={clsx("ml-1", !selectable.includes(item) && "invisible")} />
									<button type="button" onClick={() => open(item)} aria-disabled={item.trashedAt ? true : undefined} className="flex min-w-0 items-center gap-3 py-3 text-left aria-disabled:cursor-default">
										<Icon size={16} className={clsx("shrink-0", className)} fill={item.kind === "folder" ? "currentColor" : "none"} />
										<span className="truncate text-neutral-900">{item.name}</span>
										{item.shared && item.role === "owner" && <Share2 size={12} className="shrink-0 text-neutral-500" aria-label={t("drive.share")} />}
									</button>
									<span className="hidden md:block"><DriveOwnerAvatar item={item} /></span>
									<span className="hidden text-neutral-600 md:block">{dateFormat.format(new Date(item.updatedAt))}</span>
									<span className="hidden text-neutral-600 md:block">{item.kind === "file" ? formatDriveSize(item.size) : "—"}</span>
									<DropdownMenu.Root>
										<DropdownMenu.Trigger asChild>
											<button type="button" aria-label={t("drive.actions")} className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"><MoreVertical size={16} /></button>
										</DropdownMenu.Trigger>
										<DropdownMenu.Portal>
											<DropdownMenu.Content align="end" sideOffset={4} className="z-[200] min-w-52 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl">
												{!item.trashedAt && <DropdownMenu.Item className={menuItemClass} onSelect={() => open(item)}>{t("drive.open")}</DropdownMenu.Item>}
												{item.kind === "file" && !(item.source && item.trashedAt) && <DropdownMenu.Item asChild className={menuItemClass}><a href={driveFileUrl(item, true)}><Download size={16} />{t("drive.download")}</a></DropdownMenu.Item>}
												{item.source && !item.trashedAt && <DropdownMenu.Item asChild className={menuItemClass}><a href={emailUrl(item.source)} target="_blank" rel="noopener noreferrer"><Mail size={16} />{t("drive.openEmail")}</a></DropdownMenu.Item>}
												{item.role === "owner" && !item.trashedAt && <DropdownMenu.Item className={menuItemClass} onSelect={() => setSharing(item)}><Share2 size={16} />{t("drive.share")}</DropdownMenu.Item>}
												{canEditDrive(item.role) && !item.trashedAt && <DropdownMenu.Item className={menuItemClass} onSelect={() => setNaming({ mode: "rename", item, value: item.name })}><Pencil size={16} />{t("drive.rename")}</DropdownMenu.Item>}
												{item.source?.canDelete && !item.trashedAt && <DropdownMenu.Item className={menuItemClass} onSelect={() => void mutate("/api/drive/attachments", json("POST", { action: "trash", ids: [item.id] }), t("drive.trashed"))}><Trash2 size={16} />{t("drive.moveToTrash")}</DropdownMenu.Item>}
												{canEditDrive(item.role) && !item.source && !item.trashedAt && <DropdownMenu.Item className={menuItemClass} onSelect={() => void mutate(`/api/drive/items/${item.id}`, json("PATCH", { trashed: true }), t("drive.trashed"))}><Trash2 size={16} />{t("drive.moveToTrash")}</DropdownMenu.Item>}
												{item.trashedAt && <DropdownMenu.Item className={menuItemClass} onSelect={() => void (item.source ? mutate("/api/drive/attachments", json("POST", { action: "restore", ids: [item.id] }), t("drive.restored")) : mutate(`/api/drive/items/${item.id}`, json("PATCH", { trashed: false }), t("drive.restored")))}><RotateCcw size={16} />{t("drive.restore")}</DropdownMenu.Item>}
												{item.trashedAt && <DropdownMenu.Item className={clsx(menuItemClass, "text-red-600")} onSelect={() => { if (window.confirm(t("drive.confirmDelete", { name: item.name }))) void (item.source ? mutate("/api/drive/attachments", json("POST", { action: "delete", ids: [item.id] }), t("drive.deleted")) : mutate(`/api/drive/items/${item.id}`, { method: "DELETE" }, t("drive.deleted"))); }}><X size={16} />{t("drive.deleteForever")}</DropdownMenu.Item>}
											</DropdownMenu.Content>
										</DropdownMenu.Portal>
									</DropdownMenu.Root>
								</div>
							);
						})}
				</div>
			</div>
			{dragging && <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-500 bg-blue-50/80 text-blue-700"><UploadCloud size={28} /><span className="ml-3 text-base font-medium">{t("drive.fileUpload")}</span></div>}

			<Dialog open={!!naming} onOpenChange={(openState) => { if (!openState) setNaming(null); }}>
				<DialogContent>
					<DialogHeader><DialogTitle>{naming?.mode === "create" ? t("drive.newFolder") : t("drive.renameTitle")}</DialogTitle></DialogHeader>
					<form onSubmit={submitName} className="space-y-5">
						<Input autoFocus value={naming?.value ?? ""} onChange={(event) => setNaming((current) => current && { ...current, value: event.target.value })} onFocus={(event) => event.currentTarget.select()} aria-label={t("drive.folderName")} maxLength={255} />
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setNaming(null)}>{t("common.cancel")}</Button>
							<Button type="submit" disabled={!naming?.value.trim()}>{naming?.mode === "create" ? t("drive.create") : t("drive.save")}</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog open={!!preview} onOpenChange={(openState) => { if (!openState) setPreview(null); }}>
				<DialogContent overlayClassName="bg-black/65 backdrop-blur-sm" closeClassName="text-white hover:bg-[rgb(255_255_255/0.15)] hover:text-white" className="h-[min(85vh,900px)] w-[min(1100px,calc(100vw-32px))] max-w-none overflow-hidden bg-transparent p-0 shadow-none">
					{preview && (
						<div className="flex h-full flex-col">
							<DialogTitle className="flex h-14 shrink-0 items-center justify-between gap-3 pl-5 pr-14 text-white">
								<span className="truncate text-base font-medium">{preview.name}</span>
								<span className="flex shrink-0 items-center gap-1">
									{preview.source && <a href={emailUrl(preview.source)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-[rgb(255_255_255/0.15)]"><Mail size={16} />{t("drive.openEmail")}<ExternalLink size={12} /></a>}
									<a href={driveFileUrl(preview, true)} aria-label={t("drive.download")} className="rounded-full p-2 hover:bg-[rgb(255_255_255/0.15)]"><Download size={18} /></a>
								</span>
							</DialogTitle>
							<div className="min-h-0 flex-1 p-3 pt-0"><DrivePreviewBody src={driveFileUrl(preview)} downloadHref={driveFileUrl(preview, true)} contentType={preview.contentType} name={preview.name} /></div>
						</div>
					)}
				</DialogContent>
			</Dialog>

			<DriveUploadPanel uploads={uploads} onClose={() => setUploads((list) => list.filter((entry) => entry.status === "queued" || entry.status === "uploading"))} />

			<DriveShareDialog item={sharing} onClose={() => setSharing(null)} onChanged={() => void refresh()} />
		</div>
	);
}
