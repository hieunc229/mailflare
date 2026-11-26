"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Mail, Search, Users } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import type { AddOption } from "../types";
import { externalOption, fetchCandidates, groupsFetch, jsonInit, MAX_EXTERNAL_MEMBERS, memberBody, nextIndex } from "../utils";

/**
 * Search accounts and shared mailboxes and add one with Enter or a click. It follows the ARIA combobox
 * pattern (input + listbox, focus stays in the input) so the list works with arrow keys and screen readers.
 */
export function AddMembers({ groupId, disabled, memberAddresses = [], externalFull = false }: { groupId: string; disabled: boolean; memberAddresses?: string[]; externalFull?: boolean }) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const listId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [text, setText] = useState("");
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const [announcement, setAnnouncement] = useState("");
	// An external member is a billed send per message: the admin confirms in place before it is added.
	const [pending, setPending] = useState<AddOption | null>(null);
	// Addresses that used this group's unsubscribe link before: added as asked, but the admin should know.
	const [resubscribed, setResubscribed] = useState<string[]>([]);

	useEffect(() => {
		const timer = setTimeout(() => setQuery(text.trim()), 200);
		return () => clearTimeout(timer);
	}, [text]);

	const candidates = useQuery({
		queryKey: ["groups", groupId, "candidates", query],
		queryFn: () => fetchCandidates(groupId, query, t("groups.searchFailed")),
		enabled: open && !disabled,
		retry: false,
	});
	const typed = useMemo(() => (externalFull ? null : externalOption(text, memberAddresses)), [text, memberAddresses, externalFull]);
	const options: AddOption[] = [...(candidates.data?.candidates ?? []), ...(typed ? [{ kind: "external" as const, id: typed, name: typed, address: typed }] : [])];

	const add = useMutation({
		mutationFn: (candidate: AddOption) => groupsFetch<{ added: unknown[]; warnings?: { email: string }[] }>(`/api/groups/${groupId}/members`, t("groups.addFailed"), jsonInit("POST", { members: [memberBody(candidate)] })),
		onSuccess: (data, candidate) => {
			setResubscribed(data?.warnings?.map((warning) => warning.email) ?? []);
			qc.invalidateQueries({ queryKey: ["groups"] });
			setText("");
			setQuery("");
			setActive(-1);
			setPending(null);
			setAnnouncement(t("groups.added", { name: candidate.name }));
			inputRef.current?.focus();
		},
	});

	function choose(candidate: AddOption | undefined) {
		if (!candidate || add.isPending) return;
		if (candidate.kind === "external") {
			setPending(candidate);
			setOpen(false);
			return;
		}
		add.mutate(candidate);
	}

	function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setOpen(true);
			setActive((current) => nextIndex(current, event.key === "ArrowDown" ? 1 : -1, options.length));
		} else if (event.key === "Enter" && open && active >= 0) {
			event.preventDefault();
			choose(options[active]);
		} else if (event.key === "Escape" && (open || pending)) {
			event.preventDefault();
			setOpen(false);
			setActive(-1);
			setPending(null);
		}
	}

	const showList = open && !disabled;
	const status = candidates.isFetching ? t("common.loading") : candidates.isError ? (candidates.error as Error).message : options.length ? t("groups.resultCount", { count: options.length }) : t("groups.noResults");
	return <div className="relative">
		<label htmlFor={`${listId}-input`} className="mb-2 block text-sm font-medium text-neutral-900">{t("groups.addMembers")}</label>
		<div className="relative">
			<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" aria-hidden="true" />
			<input
				ref={inputRef}
				id={`${listId}-input`}
				role="combobox"
				aria-expanded={showList}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
				autoComplete="off"
				disabled={disabled}
				value={text}
				placeholder={disabled ? t("groups.memberLimit") : t("groups.searchPlaceholder")}
				onChange={(event) => { setText(event.target.value); setOpen(true); setActive(-1); }}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onKeyDown={onKeyDown}
				className="h-10 w-full rounded-md border border-neutral-200 bg-white pl-9 pr-3 text-sm shadow-sm shadow-neutral-200/50 placeholder:text-neutral-500 focus-visible:border-blue-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11"
			/>
		</div>
		<ul id={listId} role="listbox" aria-label={t("groups.addMembers")} hidden={!showList} className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 shadow-lg">
			{options.map((option, index) => <li
				key={`${option.kind}-${option.id}`}
				id={`${listId}-${index}`}
				role="option"
				aria-selected={index === active}
				// mousedown, not click: the input's blur closes the list before a click lands.
				onMouseDown={(event) => { event.preventDefault(); choose(option); }}
				onMouseMove={() => setActive(index)}
				className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm ${index === active ? "bg-blue-50" : ""}`}
			>
				{option.kind === "user" ? <Users className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" /> : <Mail className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />}
				<span className="min-w-0"><span className="block truncate font-medium text-neutral-900">{option.name}</span><span className="block truncate no-font-mono text-neutral-500">{option.address}</span></span>
				<span className="ml-auto shrink-0 text-xs text-neutral-500">{option.kind === "user" ? t("groups.kindUser") : option.kind === "mailbox" ? t("groups.kindMailbox") : t("groups.kindExternal")}</span>
			</li>)}
			{!options.length && <li role="presentation" className="px-3 py-3 text-sm text-neutral-500">{status}</li>}
		</ul>
		{pending && <div data-testid="external-confirm" role="group" aria-label={t("groups.addExternalTitle")} className="mt-3 space-y-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
			<p>{t("groups.externalCostConfirm", { email: pending.address })}</p>
			<div className="flex flex-wrap gap-2">
				<button type="button" disabled={add.isPending} onClick={() => add.mutate(pending)} className="min-h-11 rounded-md bg-neutral-900 px-4 text-sm font-medium text-white disabled:opacity-50">{t("groups.addExternalConfirm")}</button>
				<button type="button" onClick={() => { setPending(null); inputRef.current?.focus(); }} className="min-h-11 rounded-md border border-neutral-300 bg-white px-4 text-sm text-neutral-800">{t("common.cancel")}</button>
			</div>
		</div>}
		{resubscribed.length > 0 && <p data-testid="resubscribed" role="status" className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{resubscribed.map((email) => t("groups.resubscribed", { email })).join(" ")}</p>}
		<p className="mt-2 text-xs text-neutral-500">{t("groups.addHint")} {externalFull ? t("groups.externalLimit", { max: MAX_EXTERNAL_MEMBERS }) : t("groups.externalHint")}</p>
		{add.isError && <p role="alert" className="mt-2 text-sm text-red-600">{(add.error as Error).message}</p>}
		<p className="sr-only" role="status" aria-live="polite">{showList ? status : announcement}</p>
	</div>;
}
