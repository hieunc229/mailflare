"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { moveItem, readStorage, resolveLayout, writeStorage } from "./reorderable-list-utils";
import type { ReorderableDrag, ReorderableDropTarget, ReorderableLayout, ReorderableListProps } from "./reorderable-list-types";

const HOLD_MS = 350;
const subscribeNothing = () => () => {};
const hydratedOnClient = () => true;
const hydratedOnServer = () => false;
const CANCEL_DISTANCE = 6;

// Press and hold an item, then drag it. A ghost follows the pointer and a blue line marks where
// it will land; nothing moves until you let go. Lists can hand items to each other through the
// `before` row between them.
export function ReorderableList({ lists, storageKey, enabled = true }: ReorderableListProps) {
	// Storage is read after hydration so the server and first client render agree.
	const hydrated = useSyncExternalStore(subscribeNothing, hydratedOnClient, hydratedOnServer);
	const [saved, setSaved] = useState<{ key: string; layout: ReorderableLayout } | null>(null);
	const stored = saved?.key === storageKey ? saved.layout : hydrated ? readStorage<ReorderableLayout>(storageKey, {}) : {};
	const [drag, setDrag] = useState<ReorderableDrag | null>(null);
	const [target, setTarget] = useState<ReorderableDropTarget | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
	const suppressClick = useRef(false);
	const latest = useRef({ layout: {} as ReorderableLayout, target: null as ReorderableDropTarget | null });

	const layout = resolveLayout(Object.fromEntries(lists.map((list) => [list.id, list.items.map((item) => item.id)])), stored);
	const nodes = new Map(lists.flatMap((list) => list.items.map((item) => [item.id, item.node] as const)));
	useEffect(() => { latest.current.layout = layout; latest.current.target = target; });

	const dragId = drag?.id ?? null;
	useEffect(() => {
		if (!dragId) return;
		const container = containerRef.current;
		if (!container) return;

		function locate(y: number): ReorderableDropTarget | null {
			const rows = Array.from(container!.querySelectorAll<HTMLElement>("[data-reorder-id], [data-reorder-boundary]"));
			if (rows.length === 0) return null;
			const current = latest.current.layout;
			const hit = rows.find((row) => { const rect = row.getBoundingClientRect(); return y >= rect.top && y <= rect.bottom; })
				?? (y < rows[0].getBoundingClientRect().top ? rows[0] : rows[rows.length - 1]);
			const rect = hit.getBoundingClientRect();
			const upper = y < rect.top + rect.height / 2 || (y < rect.top);
			const boundaryList = hit.dataset.reorderBoundary;
			if (boundaryList !== undefined) {
				const listIds = Object.keys(current);
				const index = listIds.indexOf(boundaryList);
				if (upper) return { listId: listIds[Math.max(0, index - 1)], beforeId: null, lineY: rect.top };
				return { listId: boundaryList, beforeId: current[boundaryList]?.[0] ?? null, lineY: rect.bottom };
			}
			const id = hit.dataset.reorderId!;
			const listId = hit.dataset.reorderList!;
			if (upper) return { listId, beforeId: id, lineY: rect.top };
			const ids = current[listId];
			return { listId, beforeId: ids[ids.indexOf(id) + 1] ?? null, lineY: rect.bottom };
		}

		const onMove = (event: PointerEvent) => {
			setDrag((current) => current && { ...current, pointerY: event.clientY });
			const next = locate(event.clientY);
			setTarget((current) => current && next && current.listId === next.listId && current.beforeId === next.beforeId && current.lineY === next.lineY ? current : next);
		};
		const end = (commit: boolean) => {
			suppressClick.current = true;
			window.setTimeout(() => { suppressClick.current = false; }, 0);
			const drop = latest.current.target;
			if (commit && drop) {
				const next = moveItem(latest.current.layout, dragId, drop.listId, drop.beforeId);
				setSaved({ key: storageKey, layout: next });
				writeStorage(storageKey, next);
			}
			setDrag(null);
			setTarget(null);
		};
		const onUp = () => end(true);
		const onCancel = () => end(false);
		const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") end(false); };
		// Once holding, a touch drag must not scroll the menu.
		const blockScroll = (event: TouchEvent) => event.preventDefault();
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("keydown", onKey);
		document.addEventListener("touchmove", blockScroll, { passive: false });
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("touchmove", blockScroll);
		};
	}, [dragId, storageKey]);

	useEffect(() => () => { if (hold.current) window.clearTimeout(hold.current.timer); }, []);

	function cancelHold() {
		if (!hold.current) return;
		window.clearTimeout(hold.current.timer);
		hold.current = null;
	}

	function startHold(event: ReactPointerEvent<HTMLDivElement>, id: string) {
		if (!enabled || event.button !== 0) return;
		cancelHold();
		const element = event.currentTarget;
		const { clientX, clientY } = event;
		const timer = window.setTimeout(() => {
			hold.current = null;
			const rect = element.getBoundingClientRect();
			const listRect = containerRef.current?.getBoundingClientRect();
			setDrag({ id, left: rect.left, width: rect.width, height: rect.height, offsetY: clientY - rect.top, pointerY: clientY, listLeft: listRect?.left ?? rect.left, listWidth: listRect?.width ?? rect.width });
		}, HOLD_MS);
		hold.current = { timer, x: clientX, y: clientY };
	}

	function moveHold(event: ReactPointerEvent) {
		const current = hold.current;
		if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) > CANCEL_DISTANCE) cancelHold();
	}

	return (
		<div ref={containerRef} className={cn("flex shrink-0 flex-col gap-px", drag && "select-none")}>
			{lists.map((list) => {
				const ordered = layout[list.id] ?? [];
				const shown = list.hidden ? [] : list.visibleIds ? list.visibleIds(ordered) : ordered;
				return (
					<div key={list.id} className="contents">
						{list.before && <div data-reorder-boundary={list.id}>{list.before}</div>}
						{shown.map((id) => (
							<div key={id} data-reorder-id={id} data-reorder-list={list.id}
								onPointerDown={(event) => startHold(event, id)}
								onPointerMove={moveHold}
								onPointerUp={cancelHold}
								onPointerCancel={cancelHold}
								onDragStart={(event) => event.preventDefault()}
								onContextMenu={(event) => { if (hold.current || drag) event.preventDefault(); }}
								onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
								className={cn("shrink-0", dragId === id && "opacity-40")}>
								{nodes.get(id)}
							</div>
						))}
					</div>
				);
			})}
			{drag && target && createPortal(
				<div aria-hidden="true" className="pointer-events-none fixed z-[300] h-0.5 rounded-full bg-blue-600" style={{ left: drag.listLeft, width: drag.listWidth, top: target.lineY - 1 }} />,
				document.body,
			)}
			{drag && createPortal(
				<div aria-hidden="true" className="pointer-events-none fixed z-[301] cursor-grabbing overflow-hidden rounded-r-full bg-white opacity-90 shadow-lg ring-1 ring-neutral-200" style={{ left: drag.left, width: drag.width, top: drag.pointerY - drag.offsetY }}>
					{nodes.get(drag.id)}
				</div>,
				document.body,
			)}
		</div>
	);
}
