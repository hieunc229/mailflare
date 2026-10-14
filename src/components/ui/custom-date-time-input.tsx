"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/language-provider";
import { CustomSelect } from "./custom-select";

type DateTimeType = "date" | "time" | "datetime-local";
type Props = React.ComponentProps<"input"> & { type: DateTimeType };

const pad = (number: number) => String(number).padStart(2, "0");
const isoDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const monthDate = (year: number, month: number) => new Date(year, month, 1);
const parseDate = (value?: string) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
	if (!match) return null;
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return isoDate(date) === match[0] ? date : null;
};
const timePart = (value: string, type: DateTimeType) => type === "time" ? value : value.split("T")[1] ?? "";
const datePart = (value: string) => value.split("T")[0];

function labelText(label: HTMLLabelElement) {
	const copy = label.cloneNode(true) as HTMLLabelElement;
	copy.querySelectorAll("input, button, select, textarea").forEach((control) => control.remove());
	return copy.textContent?.trim() ?? "";
}

export const CustomDateTimeInput = React.forwardRef<HTMLInputElement, Props>(function CustomDateTimeInput(
	{ type, className, style, value, defaultValue, onChange, onFocus, onBlur, onClick, onKeyDown, disabled, readOnly, required, min, max, step, placeholder, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid, ...props }, forwardedRef,
) {
	const { locale, t } = useLanguage();
	const nativeRef = React.useRef<HTMLInputElement>(null);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const outsideInteraction = React.useRef(false);
	const popupRef = React.useRef<HTMLDivElement>(null);
	const popupId = React.useId();
	const [open, setOpen] = React.useState(false);
	const [position, setPosition] = React.useState<React.CSSProperties>({ visibility: "hidden" });
	const [uncontrolledValue, setUncontrolledValue] = React.useState(String(defaultValue ?? ""));
	const [associatedLabel, setAssociatedLabel] = React.useState<string>();
	const controlled = value !== undefined;
	const currentValue = controlled ? String(value ?? "") : uncontrolledValue;
	const today = new Date();
	const selectedDate = parseDate(currentValue);
	const [month, setMonth] = React.useState(() => monthDate((selectedDate ?? today).getFullYear(), (selectedDate ?? today).getMonth()));
	const [activeDate, setActiveDate] = React.useState(() => selectedDate ? isoDate(selectedDate) : isoDate(today));
	const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(month);
	const weekdayFormatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
	const longDateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
	const selectedTime = timePart(currentValue, type);
	const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(selectedTime);
	const hour = timeMatch ? Number(timeMatch[1]) : 9;
	const minute = timeMatch ? Number(timeMatch[2]) : 0;
	const second = timeMatch ? Number(timeMatch[3] ?? 0) : 0;
	const hasSeconds = (typeof step === "number" ? step : Number(step)) > 0 && Number(step) < 60 || !!timeMatch?.[3];
	const fullTime = (h: number, m: number, s = second) => `${pad(h)}:${pad(m)}${hasSeconds ? `:${pad(s)}` : ""}`;

	React.useImperativeHandle(forwardedRef, () => nativeRef.current!, []);
	React.useLayoutEffect(() => {
		const native = nativeRef.current;
		if (!native || ariaLabel || ariaLabelledBy) return;
		setAssociatedLabel(Array.from(native.labels ?? []).map(labelText).filter(Boolean).join(" ") || undefined);
	}, [ariaLabel, ariaLabelledBy, props.id]);
	React.useEffect(() => {
		const form = nativeRef.current?.form;
		if (!form || controlled) return;
		const reset = () => queueMicrotask(() => {
			if (nativeRef.current?.isConnected) setUncontrolledValue(nativeRef.current.value);
			setOpen(false);
		});
		form.addEventListener("reset", reset);
		return () => form.removeEventListener("reset", reset);
	}, [controlled, props.form]);
	const updatePosition = React.useCallback(() => {
		const trigger = triggerRef.current;
		const popup = popupRef.current;
		if (!trigger || !popup) return;
		const rect = trigger.getBoundingClientRect();
		const width = Math.min(336, window.innerWidth - 16);
		const maxHeight = Math.max(120, window.innerHeight - 16);
		const height = Math.min(popup.scrollHeight, maxHeight);
		const top = rect.bottom + 4 + height <= window.innerHeight - 8
			? rect.bottom + 4
			: rect.top - 4 - height >= 8 ? rect.top - 4 - height : Math.max(8, window.innerHeight - 8 - height);
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - 8 - width));
		setPosition((previous) => previous.top === top && previous.left === left && previous.width === width && previous.maxHeight === maxHeight
			? previous : { position: "fixed", top, left, width, maxHeight, overflowY: "auto" });
	}, []);
	const setPopupRef = React.useCallback((node: HTMLDivElement | null) => {
		popupRef.current = node;
		if (node) updatePosition();
	}, [updatePosition]);
	React.useLayoutEffect(() => {
		if (!open) return;
		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => { window.removeEventListener("resize", updatePosition); window.removeEventListener("scroll", updatePosition, true); };
	}, [open, type, month, updatePosition]);

	// The real input stays in the form and is the source of native min/max/step validity.
	const valid = (candidate: string) => {
		const input = nativeRef.current;
		if (!input) return false;
		const probe = input.ownerDocument.createElement("input");
		probe.type = type;
		if (min != null) probe.min = String(min);
		if (max != null) probe.max = String(max);
		if (step != null) probe.step = String(step);
		probe.value = candidate;
		return probe.value === candidate && probe.validity.valid;
	};
	const candidate = (date: string, time = fullTime(hour, minute)) => type === "date" ? date : type === "time" ? time : `${date}T${time}`;
	const firstValidTime = (date: string, preferred = selectedTime) => {
		if ((min && date < datePart(String(min))) || (max && date > datePart(String(max)))) return null;
		const preferredValue = candidate(date, preferred || fullTime(9, 0));
		if (valid(preferredValue)) return preferredValue;
		const probe = nativeRef.current?.ownerDocument.createElement("input");
		if (!probe) return null;
		probe.type = "datetime-local";
		probe.value = `${date}T00:00`;
		const dayStart = probe.valueAsNumber;
		if (!Number.isFinite(dayStart)) return null;
		let lower = dayStart;
		let upper = dayStart + 86400000 - 1;
		let base = 0;
		if (min) { probe.value = String(min); if (Number.isFinite(probe.valueAsNumber)) { lower = Math.max(lower, probe.valueAsNumber); base = probe.valueAsNumber; } }
		if (max) { probe.value = String(max); if (Number.isFinite(probe.valueAsNumber)) upper = Math.min(upper, probe.valueAsNumber); }
		if (lower > upper) return null;
		const secondsStep = step === "any" ? 0 : step != null && Number(step) > 0 ? Number(step) : 60;
		const increment = secondsStep * 1000;
		const next = increment ? base + Math.ceil((lower - base) / increment) * increment : lower;
		if (next > upper) return null;
		const value = new Date(next).toISOString().replace("Z", "").replace(/\.\d{3}$/, "").slice(0, hasSeconds ? 19 : 16);
		return valid(value) ? value : null;
	};
	const isDateEnabled = (date: string) => type === "date" ? valid(date) : firstValidTime(date) !== null;
	const moveMonth = (offset: number) => {
		const nextMonth = monthDate(month.getFullYear(), month.getMonth() + offset);
		setMonth(nextMonth);
		const first = Array.from({ length: new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate() }, (_, index) => isoDate(new Date(nextMonth.getFullYear(), nextMonth.getMonth(), index + 1))).find(isDateEnabled);
		if (first) setActiveDate(first);
	};
	const commit = (nextValue: string) => {
		const native = nativeRef.current;
		if (!native || !valid(nextValue) || disabled || readOnly) return;
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(native, nextValue);
		if (!controlled) setUncontrolledValue(native.value);
		native.dispatchEvent(new Event("input", { bubbles: true }));
		native.dispatchEvent(new Event("change", { bubbles: true }));
	};
	const chooseDate = (date: string) => {
		const next = type === "date" ? date : firstValidTime(date);
		if (!next) return;
		commit(next);
		setActiveDate(date);
		setOpen(false);
		triggerRef.current?.focus();
	};
	const chooseTime = (nextHour: number, nextMinute: number, nextSecond = second) => {
		const date = selectedDate ? isoDate(selectedDate) : isoDate(new Date());
		const next = candidate(date, fullTime(nextHour, nextMinute, nextSecond));
		if (valid(next)) commit(next);
	};
	const displayedDate = selectedDate ? longDateFormatter.format(selectedDate) : "";
	const displayedTime = timeMatch ? `${pad(hour)}:${pad(minute)}${hasSeconds ? `:${pad(second)}` : ""}` : "";
	const display = type === "date" ? displayedDate : type === "time" ? displayedTime : [displayedDate, displayedTime].filter(Boolean).join(" · ");
	const gridStart = new Date(month.getFullYear(), month.getMonth(), 1 - new Date(month.getFullYear(), month.getMonth(), 1).getDay());
	const days = Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
	const selectClass = "h-9 min-w-0 flex-1 px-2 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

	return (
		<DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={false}>
		<div className="relative w-full min-w-0" data-ui-date-time={type}>
			<input {...props} ref={nativeRef} type={type} value={value} defaultValue={defaultValue} min={min} max={max} step={step} required={required} disabled={disabled} readOnly={readOnly} onChange={(event) => { if (!controlled) setUncontrolledValue(event.currentTarget.value); onChange?.(event); }} onFocus={() => triggerRef.current?.focus()} onClick={(event) => { event.preventDefault(); triggerRef.current?.click(); }} aria-hidden="true" tabIndex={-1} className="absolute h-px w-px overflow-hidden border-0 p-0 opacity-0 pointer-events-none" />
			<button ref={triggerRef} type="button" disabled={disabled} aria-label={ariaLabel ?? associatedLabel ?? placeholder ?? (type === "time" ? "Choose time" : "Choose date")} aria-labelledby={ariaLabelledBy} aria-describedby={ariaDescribedBy} aria-invalid={ariaInvalid} aria-required={required} aria-expanded={open} aria-controls={open ? popupId : undefined} aria-haspopup="dialog" onFocus={onFocus as React.FocusEventHandler<HTMLButtonElement>} onBlur={onBlur as React.FocusEventHandler<HTMLButtonElement>} onClick={(event) => { onClick?.(event as unknown as React.MouseEvent<HTMLInputElement>); if (!readOnly) { const date = parseDate(currentValue); if (date) { setMonth(monthDate(date.getFullYear(), date.getMonth())); setActiveDate(isoDate(date)); } setOpen((wasOpen) => !wasOpen); } }} onKeyDown={(event) => { onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLInputElement>); if (event.defaultPrevented) return; if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!readOnly) setOpen(true); } }} className={cn("flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-neutral-200 bg-transparent px-3 py-2 text-start text-sm text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100", className)} style={style}>
				<span className={cn("min-w-0 truncate", !display && "text-neutral-500 dark:text-neutral-400")}>{display || placeholder || (type === "time" ? "Choose time" : "Choose date")}</span>
				{type === "time" ? <Clock3 className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" /> : <CalendarDays className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />}
			</button>
		</div>
		{open && <DialogPrimitive.Portal><DialogPrimitive.Content ref={setPopupRef} id={popupId} aria-label={type === "time" ? "Choose time" : type === "date" ? "Choose date" : "Choose date and time"} aria-describedby={undefined} data-ui-date-time-popup="" onOpenAutoFocus={(event) => { event.preventDefault(); outsideInteraction.current = false; requestAnimationFrame(() => { const target = popupRef.current?.querySelector<HTMLButtonElement>('[role="gridcell"][tabindex="0"]:not(:disabled)') ?? popupRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'); target?.focus(); }); }} onCloseAutoFocus={(event) => { event.preventDefault(); if (!outsideInteraction.current) triggerRef.current?.focus(); }} onInteractOutside={(event) => { if (event.target instanceof Node && triggerRef.current?.contains(event.target) || event.target instanceof Element && event.target.closest('[data-ui-popup="select"]')) event.preventDefault(); else outsideInteraction.current = true; }} style={position} className="z-[80] rounded-lg border border-neutral-200 bg-white p-3 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
				<DialogPrimitive.Title className="sr-only">{type === "time" ? "Choose time" : type === "date" ? "Choose date" : "Choose date and time"}</DialogPrimitive.Title>
				{type !== "time" && <>
					<div className="mb-2 flex items-center justify-between gap-2">
						<button type="button" aria-label={t("calendar.previousMonth")} onClick={() => moveMonth(-1)} className="rounded-md p-2 active:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:active:bg-neutral-800"><ChevronLeft className="h-4 w-4" /></button>
						<strong className="text-sm font-medium">{monthLabel}</strong>
						<button type="button" aria-label={t("calendar.nextMonth")} onClick={() => moveMonth(1)} className="rounded-md p-2 active:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:active:bg-neutral-800"><ChevronRight className="h-4 w-4" /></button>
					</div>
					<div className="grid grid-cols-7 gap-1 text-center text-xs text-neutral-500 dark:text-neutral-400">{Array.from({ length: 7 }, (_, day) => <span key={day} aria-hidden="true" className="py-1">{weekdayFormatter.format(new Date(2023, 0, 1 + day))}</span>)}</div>
					<div role="grid" aria-label={monthLabel} className="grid grid-cols-7 gap-1" onKeyDown={(event) => { const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }; const offset = offsets[event.key]; if (!offset) return; event.preventDefault(); let next = parseDate(activeDate) ?? new Date(); for (let i = 0; i < 370; i++) { next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + offset); if (isDateEnabled(isoDate(next))) { setActiveDate(isoDate(next)); setMonth(monthDate(next.getFullYear(), next.getMonth())); requestAnimationFrame(() => popupRef.current?.querySelector<HTMLButtonElement>(`[data-date="${isoDate(next)}"]`)?.focus()); break; } } }}>
						{days.map((date) => { const iso = isoDate(date); const available = isDateEnabled(iso); return <button key={iso} type="button" role="gridcell" data-date={iso} aria-label={longDateFormatter.format(date)} aria-selected={iso === datePart(currentValue)} tabIndex={iso === activeDate ? 0 : -1} disabled={!available} onClick={() => chooseDate(iso)} className={cn("h-9 rounded-md text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 active:bg-blue-100 dark:active:bg-blue-900", date.getMonth() !== month.getMonth() && "text-neutral-400 dark:text-neutral-500", iso === datePart(currentValue) && "bg-blue-600 text-white", !available && "cursor-not-allowed opacity-35")}>{date.getDate()}</button>; })}
					</div>
				</>}
				{type !== "date" && <div className={cn("flex items-center gap-2", type === "datetime-local" && "mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-700")}>
					<Clock3 className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
					<CustomSelect aria-label="Hour" value={pad(hour)} onChange={(event) => { const nextHour = Number(event.target.value); const firstMinute = [minute, ...Array.from({ length: 60 }, (_, index) => index)].find((m) => valid(candidate(selectedDate ? isoDate(selectedDate) : isoDate(new Date()), fullTime(nextHour, m, 0)))); if (firstMinute !== undefined) chooseTime(nextHour, firstMinute, 0); }} className={selectClass}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={pad(h)}>{pad(h)}</option>)}</CustomSelect>
					<span aria-hidden="true">:</span>
					<CustomSelect aria-label="Minute" value={pad(minute)} onChange={(event) => chooseTime(hour, Number(event.target.value), 0)} className={selectClass}>{Array.from({ length: 60 }, (_, m) => <option key={m} value={pad(m)} disabled={!valid(candidate(selectedDate ? isoDate(selectedDate) : isoDate(new Date()), fullTime(hour, m, 0)))}>{pad(m)}</option>)}</CustomSelect>
					{hasSeconds && <><span aria-hidden="true">:</span><CustomSelect aria-label="Second" value={pad(second)} onChange={(event) => chooseTime(hour, minute, Number(event.target.value))} className={selectClass}>{Array.from({ length: 60 }, (_, s) => <option key={s} value={pad(s)} disabled={!valid(candidate(selectedDate ? isoDate(selectedDate) : isoDate(new Date()), fullTime(hour, minute, s)))}>{pad(s)}</option>)}</CustomSelect></>}
				</div>}
			</DialogPrimitive.Content></DialogPrimitive.Portal>}
		</DialogPrimitive.Root>
	);
});
CustomDateTimeInput.displayName = "CustomDateTimeInput";
