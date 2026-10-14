"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export function CustomMultiSelect({ label, summary, options, values, open, onOpenChange, onToggle }: {
	label: string; summary: string; options: { value: string; label: ReactNode }[]; values: string[];
	open: boolean; onOpenChange: (open: boolean) => void; onToggle: (value: string, checked: boolean) => void;
}) {
	return <Dropdown.Root open={open} onOpenChange={onOpenChange}>
		<Dropdown.Trigger asChild><button type="button" aria-label={label} className="flex h-10 w-full min-w-0 items-center justify-between gap-3 rounded-md border border-neutral-200 bg-white px-3 text-start text-sm">
			<span className="min-w-0 flex-1 truncate">{summary}</span><ChevronDown className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
		</button></Dropdown.Trigger>
		<Dropdown.Portal><Dropdown.Content align="start" sideOffset={8} collisionPadding={8} style={{ width: "var(--radix-dropdown-menu-trigger-width)", maxHeight: "min(18rem, var(--radix-dropdown-menu-content-available-height))" }} className="z-[100] overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 text-sm text-neutral-800">
			{options.map((option) => <Dropdown.CheckboxItem key={option.value} checked={values.includes(option.value)} onCheckedChange={(checked) => onToggle(option.value, checked === true)} onSelect={(event) => event.preventDefault()} className="flex min-h-9 cursor-default items-center gap-3 rounded-md px-3 py-2 outline-none data-[highlighted]:bg-neutral-100">
				<span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-neutral-300"><Dropdown.ItemIndicator><Check className="h-3 w-3 text-blue-600" /></Dropdown.ItemIndicator></span><span className="min-w-0 truncate">{option.label}</span>
			</Dropdown.CheckboxItem>)}
		</Dropdown.Content></Dropdown.Portal>
	</Dropdown.Root>;
}
