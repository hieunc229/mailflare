"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Note } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { ConversationNotesProvider, useConversationNotes } from "./conversation-notes-context";
import { NotesBody } from "./conversation-notes";

const WIDTH = 380;
const GAP = 4;
const MARGIN = 8;
const OPEN_DELAY = 150;
const CLOSE_DELAY = 250;
const NO_EMAILS: [] = [];

type Placement = { left: number; top?: number; bottom?: number; maxHeight: number };

/**
 * Note icon and count on a list row. Hovering (or focusing) it opens the
 * conversation's notes, the same ones as inside the email, and they can be
 * edited, deleted or added to there. Once the cursor goes into a note the
 * popover stays until a click outside it or Escape.
 */
export function MessageNotesPopover({ messageId, count, preview }: { messageId: string; count?: number; preview?: string }) {
	const { t } = useLanguage();
	const [armed, setArmed] = useState(false);
	const [open, setOpen] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [placement, setPlacement] = useState<Placement | null>(null);
	const triggerRef = useRef<HTMLSpanElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const timer = useRef<number | null>(null);

	const clearTimer = useCallback(() => {
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = null;
	}, []);
	const show = useCallback(() => {
		clearTimer();
		timer.current = window.setTimeout(() => {
			setArmed(true);
			setOpen(true);
		}, OPEN_DELAY);
	}, [clearTimer]);
	const hide = useCallback(() => {
		clearTimer();
		if (pinned) return;
		timer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY);
	}, [clearTimer, pinned]);
	const close = useCallback(() => {
		clearTimer();
		setPinned(false);
		setOpen(false);
	}, [clearTimer]);

	useEffect(() => clearTimer, [clearTimer]);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
			close();
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") close();
		}
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, close]);

	useLayoutEffect(() => {
		if (!open) return;
		function place() {
			const rect = triggerRef.current?.getBoundingClientRect();
			if (!rect) return;
			const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
			const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
			const below = window.innerHeight - rect.bottom - GAP - MARGIN;
			const above = rect.top - GAP - MARGIN;
			setPlacement(below >= 260 || below >= above
				? { left, top: rect.bottom + GAP, maxHeight: below }
				: { left, bottom: window.innerHeight - rect.top + GAP, maxHeight: above });
		}
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	// A portal still bubbles React events to the row, which navigates, drags and selects.
	const contain = (event: SyntheticEvent) => event.stopPropagation();

	const panel = armed && open && typeof document !== "undefined"
		? createPortal(
			<div
				ref={panelRef}
				role="dialog"
				aria-label={t("note.title")}
				onMouseEnter={clearTimer}
				onMouseLeave={hide}
				onFocusCapture={() => setPinned(true)}
				onClick={contain}
				onDoubleClick={contain}
				onMouseDown={contain}
				onPointerDown={contain}
				onKeyDown={contain}
				onDragStart={contain}
				onContextMenu={contain}
				className="fixed z-[100] flex flex-col overflow-hidden rounded-lg border border-amber-200 bg-amber-50 text-left text-sm font-normal shadow-lg"
				style={{
					left: placement?.left ?? 0,
					top: placement?.top,
					bottom: placement?.bottom,
					width: Math.min(WIDTH, window.innerWidth - MARGIN * 2),
					maxHeight: placement?.maxHeight,
					visibility: placement ? "visible" : "hidden",
				}}
			>
				<div className="min-h-0 overflow-y-auto">
					<PopoverBody fallback={preview} onEmpty={close} />
				</div>
			</div>,
			document.body,
		)
		: null;

	const label = t("note.count", { count: count ?? 0 });
	return (
		<span
			ref={triggerRef}
			className="relative z-10 inline-flex"
			onMouseEnter={show}
			onMouseLeave={hide}
			onFocus={show}
			onBlur={(event) => {
				if (!panelRef.current?.contains(event.relatedTarget as Node | null)) hide();
			}}
			onClick={(event: MouseEvent) => event.stopPropagation()}
		>
			{armed ? (
				<ConversationNotesProvider messageId={messageId} emails={NO_EMAILS}>
					<Trigger fallbackCount={count ?? 0} label={label} expanded={open} onToggle={() => (open ? close() : (setArmed(true), setOpen(true)))} />
					{panel}
				</ConversationNotesProvider>
			) : (
				<TriggerButton count={count ?? 0} label={label} expanded={false} onToggle={() => { setArmed(true); setOpen(true); }} />
			)}
		</span>
	);
}

function Trigger({ fallbackCount, label, expanded, onToggle }: { fallbackCount: number; label: string; expanded: boolean; onToggle: () => void }) {
	const notes = useConversationNotes();
	const count = notes && !notes.loading ? notes.notes.length : fallbackCount;
	return <TriggerButton count={count} label={label} expanded={expanded} onToggle={onToggle} />;
}

function TriggerButton({ count, label, expanded, onToggle }: { count: number; label: string; expanded: boolean; onToggle: () => void }) {
	if (count === 0) return null;
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={label}
			aria-expanded={expanded}
			className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs font-normal text-amber-700 transition-colors hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
		>
			<Note className="h-3.5 w-3.5" aria-hidden="true" />
			{count}
		</button>
	);
}

function PopoverBody({ fallback, onEmpty }: { fallback?: string; onEmpty: () => void }) {
	const notes = useConversationNotes();
	const empty = !!notes && !notes.loading && notes.notes.length === 0;
	useEffect(() => {
		if (empty) onEmpty();
	}, [empty, onEmpty]);
	if (!notes || notes.loading) {
		return <p className="whitespace-pre-line px-3 py-2 text-xs text-amber-900/80">{fallback}</p>;
	}
	return <NotesBody bare />;
}

/** Static note icon and count for rows that cannot hover, such as the stacked mobile row. */
export function NoteBadge({ count }: { count?: number }) {
	const { t } = useLanguage();
	if (!count) return null;
	return (
		<span className="mr-1.5 inline-flex items-center gap-0.5 align-middle text-xs font-normal text-amber-700" role="img" aria-label={t("note.count", { count })}>
			<Note className="h-3 w-3" aria-hidden="true" />
			{count}
		</span>
	);
}
