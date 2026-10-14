"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type CustomComboboxProps = Omit<React.ComponentProps<"input">, "list" | "value" | "onChange"> & {
	value: string;
	onChange: (value: string) => void;
	options: readonly string[];
	containerClassName?: string;
};

export function CustomCombobox({ value, onChange, options, className, containerClassName, onKeyDown, onFocus, onBlur, ...inputProps }: CustomComboboxProps) {
	const [open, setOpen] = React.useState(false);
	const [activeIndex, setActiveIndex] = React.useState(-1);
	const rootRef = React.useRef<HTMLDivElement>(null);
	const listId = React.useId();
	const inputRef = React.useRef<HTMLInputElement>(null);
	const popupRef = React.useRef<HTMLDivElement>(null);
	const [position, setPosition] = React.useState<React.CSSProperties>();
	const visibleOptions = React.useMemo(() => {
		const query = value.trim().toLocaleLowerCase();
		return options.filter((option) => !query || option.toLocaleLowerCase().includes(query));
	}, [options, value]);
	React.useLayoutEffect(() => {
		if (!open) return;
		const update = () => {
			const input = inputRef.current;
			if (!input) return;
			const rect = input.getBoundingClientRect();
			const viewport = window.visualViewport;
			const viewportTop = viewport?.offsetTop ?? 0;
			const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
			const below = Math.max(0, viewportBottom - rect.bottom - 16);
			const above = Math.max(0, rect.top - viewportTop - 16);
			const desired = Math.min(256, Math.max(40, visibleOptions.length * 36 + 8));
			const upwards = below < desired && above > below;
			const maxHeight = Math.min(desired, upwards ? above : below);
			setPosition({ position: "fixed", left: rect.left, width: rect.width, maxHeight, top: upwards ? undefined : rect.bottom + 8, bottom: upwards ? window.innerHeight - rect.top + 8 : undefined });
		};
		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		window.visualViewport?.addEventListener("resize", update);
		return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); window.visualViewport?.removeEventListener("resize", update); };
	}, [open, visibleOptions.length]);
	React.useEffect(() => {
		if (open && activeIndex >= 0) document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
	}, [open, activeIndex, listId]);

	React.useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !popupRef.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("pointerdown", closeOutside);
		return () => document.removeEventListener("pointerdown", closeOutside);
	}, [open]);

	function choose(option: string) {
		onChange(option);
		setActiveIndex(-1);
		inputRef.current?.focus();
		setOpen(false);
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		onKeyDown?.(event);
		if (event.defaultPrevented) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setOpen(true);
			setActiveIndex((index) => visibleOptions.length ? index < 0 ? event.key === "ArrowDown" ? 0 : visibleOptions.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + visibleOptions.length) % visibleOptions.length : -1);
		} else if (event.key === "Enter" && open && activeIndex >= 0 && visibleOptions[activeIndex]) {
			event.preventDefault();
			choose(visibleOptions[activeIndex]);
		} else if (event.key === "Escape") setOpen(false);
		else if (event.key === "Tab") setOpen(false);
	}

	return <div ref={rootRef} className={cn("relative min-w-0", containerClassName)} data-ui-combobox="">
		<div className="relative">
			<input {...inputProps} ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined} value={value} onChange={(event) => { onChange(event.currentTarget.value); setOpen(true); setActiveIndex(-1); }} onFocus={(event) => { onFocus?.(event); setOpen(true); }} onBlur={(event) => { onBlur?.(event); if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={handleKeyDown} className={cn("flex h-10 w-full min-w-0 rounded-md border border-neutral-200 bg-white py-2 ps-3 pe-9 text-sm text-neutral-800 placeholder:text-neutral-500 focus-visible:border-blue-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50", className)} />
			<button type="button" tabIndex={-1} disabled={inputProps.disabled} aria-label="Show suggestions" aria-hidden="true" onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((shown) => !shown)} className="absolute [inset-block:0] end-0 inline-flex w-9 items-center justify-center text-neutral-500" data-ui-combobox-toggle=""><ChevronDown className="h-4 w-4" /></button>
		</div>
		{open && position && createPortal(<div ref={popupRef} id={listId} role="listbox" data-ui-popup="combobox" style={position} className="z-[100] min-w-0 overflow-y-auto overscroll-contain rounded-lg border border-neutral-200 bg-white p-1 text-neutral-800">
			{visibleOptions.length ? visibleOptions.map((option, index) => <button key={option} id={`${listId}-option-${index}`} type="button" tabIndex={-1} role="option" aria-selected={option === value} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)} className={cn("flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-start text-sm", activeIndex === index ? "bg-blue-50 text-blue-900" : "text-neutral-800 hover:bg-blue-50 hover:text-blue-900")}>
				<span className="min-w-0 truncate">{option.replaceAll("_", " ")}</span>{option === value && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-blue-700" />}
			</button>) : <div className="px-3 py-2 text-sm text-neutral-500" role="status">No suggestions</div>}
		</div>, document.body)}
	</div>;
}
