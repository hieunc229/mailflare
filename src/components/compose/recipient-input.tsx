"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Label } from "@/components/ui/label";
import { getEmailAddress } from "@/lib/email/address";
import { cn } from "@/lib/utils";
import type { RecipientInputProps } from "./recipient-input-types";
import { getRecipientLabel, isValidRecipient, parseRecipientEntries } from "./recipient-utils";

/**
 * A To/Cc/Bcc row. Addresses become chips as soon as the user types a comma,
 * presses Enter or Tab, pastes a list, or leaves the field; Backspace on an
 * empty field pulls the last chip back out for editing.
 */
export function RecipientInput({
	id,
	label,
	value,
	onChange,
	placeholder,
	disabled,
	required,
	autoFocus,
	trailing,
}: RecipientInputProps) {
	const { t } = useLanguage();
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);

	function commit(raw = draft) {
		const entries = parseRecipientEntries(raw, value);
		if (entries.length > 0) onChange([...value, ...entries]);
		setDraft("");
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "," || event.key === ";" || event.key === "Enter" || (event.key === "Tab" && draft.trim())) {
			if (event.key !== "Tab") event.preventDefault();
			commit();
			return;
		}
		if (event.key === "Backspace" && !draft && value.length > 0) {
			event.preventDefault();
			const last = value[value.length - 1];
			onChange(value.slice(0, -1));
			setDraft(last);
		}
	}

	return (
		<div
			className="flex min-h-9 items-center gap-2 border-b border-neutral-100 px-4 py-1"
			onClick={() => inputRef.current?.focus()}
		>
			<Label htmlFor={id} className="w-8 shrink-0 text-sm text-neutral-500">
				{label}
			</Label>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
				{value.map((entry) => {
					const valid = isValidRecipient(entry);
					return (
						<span
							key={entry}
							title={getEmailAddress(entry)}
							className={cn(
								"inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
								valid
									? "border-neutral-200 bg-neutral-50 text-neutral-800"
									: "border-red-200 bg-red-50 text-red-700",
							)}
						>
							<span className="truncate">{getRecipientLabel(entry)}</span>
							{!disabled && (
								<button
									type="button"
									aria-label={t("recipient.remove", { address: getEmailAddress(entry) })}
									className="rounded-full p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700"
									onClick={(event) => {
										event.stopPropagation();
										onChange(value.filter((item) => item !== entry));
									}}
								>
									<X className="h-3 w-3" />
								</button>
							)}
						</span>
					);
				})}
				<input
					ref={inputRef}
					id={id}
					value={draft}
					onChange={(event) => {
						// A pasted list should split immediately instead of waiting for a comma.
						if (/[,;]/.test(event.target.value) && event.target.value.length - draft.length > 1) {
							commit(event.target.value);
							return;
						}
						setDraft(event.target.value);
					}}
					onKeyDown={onKeyDown}
					onBlur={() => commit()}
					type="text"
					autoComplete="off"
					autoFocus={autoFocus}
					spellCheck={false}
					placeholder={value.length === 0 ? placeholder : undefined}
					disabled={disabled}
					// Native `required` would block submit while chips exist; the form checks itself.
					aria-required={required}
					className="h-7 min-w-32 flex-1 border-0 bg-transparent p-0 text-sm outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed"
				/>
			</div>
			{trailing && (
				// Toggles live inside the clickable row; keep their clicks from refocusing this field.
				<div
					className="flex shrink-0 items-center gap-1 text-xs text-neutral-500"
					onClick={(event) => event.stopPropagation()}
				>
					{trailing}
				</div>
			)}
		</div>
	);
}
