"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { SuppressionPage } from "./types";
import { confirmSuppression, deleteSuppression, fetchSuppressions, formatEventDate, PAGE_SIZE } from "./utils";

export function SuppressionList({ domainId }: { domainId: string }) {
	const { t } = useLanguage();
	const [query, setQuery] = useState("");
	const [reason, setReason] = useState("");
	const [offset, setOffset] = useState(0);
	const [page, setPage] = useState<SuppressionPage | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (search: string) => {
		setError(null);
		try {
			setPage(await fetchSuppressions(domainId, { q: search, reason, offset }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("deliverability.loadFailed"));
		}
	}, [domainId, reason, offset, t]);

	// Typing waits a moment so every keystroke is not a request; paging and filters reload straight away.
	useEffect(() => {
		const timer = setTimeout(() => void load(query), query ? 250 : 0);
		return () => clearTimeout(timer);
	}, [load, query]);

	async function remove(id: string, email: string) {
		if (!await confirmDestructive({ message: t("deliverability.removeConfirm", { email }), confirmLabel: t("deliverability.remove") })) return;
		try {
			await deleteSuppression(domainId, id);
			await load(query);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("deliverability.removeFailed"));
		}
	}

	async function confirm(id: string) {
		try {
			await confirmSuppression(domainId, id);
			await load(query);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("deliverability.confirmFailed"));
		}
	}

	const total = page?.total ?? 0;
	const first = total === 0 ? 0 : offset + 1;
	const last = Math.min(offset + PAGE_SIZE, total);
	return <section className="space-y-3">
		<h2 className="text-sm font-semibold text-neutral-900">{t("deliverability.list.title")}</h2>
		<div className="flex flex-col gap-3 sm:flex-row">
			<Input type="search" aria-label={t("deliverability.search")} placeholder={t("deliverability.search")} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} className="bg-white sm:max-w-xs" />
			<Select aria-label={t("deliverability.col.reason")} value={reason} containerClassName="w-full sm:w-56" className="h-10 text-sm" onChange={(event) => { setReason(event.target.value); setOffset(0); }}>
				<option value="">{t("deliverability.filter.all")}</option>
				<option value="hard_bounce">{t("deliverability.reason.hard_bounce")}</option>
				<option value="complaint">{t("deliverability.reason.complaint")}</option>
				<option value="manual">{t("deliverability.reason.manual")}</option>
			</Select>
		</div>
		{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
		<div role="region" tabIndex={0} aria-label={t("deliverability.list.title")} className="overflow-x-auto rounded-2xl bg-white" aria-busy={!page && !error}>
			<table className="w-full min-w-[720px] text-left text-sm">
				<thead className="border-b border-neutral-100 bg-neutral-50 text-xs font-semibold uppercase tracking-wide text-neutral-500">
					<tr>
						<th scope="col" className="px-4 py-3">{t("deliverability.col.address")}</th>
						<th scope="col" className="px-4 py-3">{t("deliverability.col.reason")}</th>
						<th scope="col" className="px-4 py-3">{t("deliverability.col.source")}</th>
						<th scope="col" className="px-4 py-3 text-right">{t("deliverability.col.events")}</th>
						<th scope="col" className="px-4 py-3">{t("deliverability.col.lastEvent")}</th>
						<th scope="col" className="px-4 py-3"><span className="sr-only">{t("deliverability.remove")}</span></th>
					</tr>
				</thead>
				<tbody className="divide-y divide-neutral-100">
					{page?.items.map((row) => <tr key={row.id}>
						<td className="max-w-64 break-all px-4 py-3" title={row.detail ?? undefined}>{row.email}</td>
						<td className="px-4 py-3">{t(`deliverability.reason.${row.reason}`)}{!row.confirmed && <span title={t("deliverability.unconfirmedHint")} className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">{t("deliverability.unconfirmed")}</span>}</td>
						<td className="px-4 py-3">{t(`deliverability.source.${row.source}`)}</td>
						<td className="px-4 py-3 text-right tabular-nums">{row.eventCount}</td>
						<td className="whitespace-nowrap px-4 py-3 text-neutral-600">{formatEventDate(row.lastEventAt)}</td>
						<td className="space-x-2 whitespace-nowrap px-4 py-3 text-right">{!row.confirmed && <Button type="button" variant="outline" size="sm" aria-label={`${t("deliverability.confirm")} ${row.email}`} onClick={() => void confirm(row.id)}>{t("deliverability.confirm")}</Button>}<Button type="button" variant="outline" size="sm" aria-label={`${t("deliverability.remove")} ${row.email}`} onClick={() => void remove(row.id, row.email)}>{t("deliverability.remove")}</Button></td>
					</tr>)}
					{page && page.items.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-neutral-500">{t("deliverability.empty")}</td></tr>}
					{!page && !error && <tr><td colSpan={6} className="px-4 py-8 text-center text-neutral-500">{t("deliverability.loading")}</td></tr>}
				</tbody>
			</table>
		</div>
		{page && total > PAGE_SIZE && <div className="flex items-center justify-end gap-3 text-sm text-neutral-600">
			<span>{t("deliverability.showing", { from: first, to: last, total })}</span>
			<Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t("deliverability.previous")}</Button>
			<Button type="button" variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t("deliverability.next")}</Button>
		</div>}
	</section>;
}
