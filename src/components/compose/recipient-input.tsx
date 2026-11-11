"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Label } from "@/components/ui/label";
import { getEmailAddress } from "@/lib/email/address";
import { cn } from "@/lib/utils";
import type { RecipientInputProps } from "./recipient-input-types";
import type { ContactSuggestion } from "./recipient-suggestions-types";
import { RecipientSuggestions } from "./recipient-suggestions";
import { fetchContactSuggestions, filterContactSuggestions, formatContactSuggestion } from "./recipient-suggestions-utils";
import { getRecipientLabel, isValidRecipient, parseRecipientEntries } from "./recipient-utils";

const SUGGESTIONS_DEBOUNCE_MS = 180;

/**
 * A To/Cc/Bcc row. Addresses become chips as soon as the user types a comma,
 * presses Enter or Tab, pastes a list, or leaves the field; Backspace on an
 * empty field pulls the last chip back out for editing. With a mailboxId the
 * field also offers matching contacts as suggestions.
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
	mailboxId,
}: RecipientInputProps) {
	const { t } = useLanguage();
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const requestRef = useRef(0);

	const visibleSuggestions = suggestionsOpen ? filterContactSuggestions(suggestions, value) : [];
	const activeSuggestion = activeIndex >= 0 ? visibleSuggestions[activeIndex] : undefined;

	useEffect(() => {
		const query = draft.trim();
		if (!mailboxId || disabled || !query) return;
		const request = ++requestRef.current;
		const timer = setTimeout(() => {
			fetchContactSuggestions(mailboxId, query)
				.then((list) => {
					if (requestRef.current !== request) return;
					setSuggestions(list);
					setSuggestionsOpen(list.length > 0);
					setActiveIndex(-1);
				})
				.catch(() => {
					// Suggestions are a convenience; a failed lookup just shows none.
				});
		}, SUGGESTIONS_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [draft, disabled, mailboxId]);

	function closeSuggestions() {
		setSuggestionsOpen(false);
		setActiveIndex(-1);
	}

	function updateDraft(next: string) {
		setDraft(next);
		if (!next.trim()) closeSuggestions();
	}

	function commit(raw = draft) {
		const entries = parseRecipientEntries(raw, value);
		if (entries.length > 0) onChange([...value, ...entries]);
		setDraft("");
		closeSuggestions();
	}

	function pickSuggestion(suggestion: ContactSuggestion) {
		const entries = parseRecipientEntries(formatContactSuggestion(suggestion), value);
		if (entries.length > 0) onChange([...value, ...entries]);
		setDraft("");
		closeSuggestions();
		inputRef.current?.focus();
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (suggestionsOpen && visibleSuggestions.length > 0) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActiveIndex((current) =>
					(current + step + visibleSuggestions.length) % visibleSuggestions.length,
				);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				closeSuggestions();
				return;
			}
			if ((event.key === "Enter" || event.key === "Tab") && activeSuggestion) {
				event.preventDefault();
				pickSuggestion(activeSuggestion);
				return;
			}
		}
		if (event.key === "," || event.key === ";" || event.key === "Enter" || (event.key === "Tab" && draft.trim())) {
			if (event.key !== "Tab") event.preventDefault();
			commit();
			return;
		}
		if (event.key === "Backspace" && !draft && value.length > 0) {
			event.preventDefault();
			const last = value[value.length - 1];
			onChange(value.slice(0, -1));
			updateDraft(last);
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
			<div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
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
						updateDraft(event.target.value);
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
					role="combobox"
					aria-expanded={suggestionsOpen}
					aria-controls={`${id}-suggestions`}
					aria-activedescendant={activeSuggestion ? `${id}-suggestion-${activeIndex}` : undefined}
					aria-autocomplete="list"
					className="h-7 min-w-32 flex-1 border-0 bg-transparent p-0 text-sm outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed"
				/>
				{mailboxId && visibleSuggestions.length > 0 && (
					<RecipientSuggestions
						id={id}
						mailboxId={mailboxId}
						suggestions={visibleSuggestions}
						activeIndex={activeIndex}
						onPick={pickSuggestion}
						onHover={setActiveIndex}
					/>
				)}
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
