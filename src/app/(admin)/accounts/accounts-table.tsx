"use client";

import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreVertical, RotateCcw, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { getAccountPurgeDate, getAccountStatus } from "@/lib/accounts/deletion-utils";
import { formatAccountDate, formatAccountDateTime } from "./utils";
import type { AccountsTableProps } from "./accounts-table-types";

const COLUMNS = "grid grid-cols-[auto_minmax(0,1fr)_1.75rem] items-center gap-x-4 md:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_1.75rem]";
const STATUS_STYLES = {
	active: "bg-green-600/10 text-green-800",
	disabled: "bg-neutral-100 text-neutral-600",
	pendingDeletion: "bg-red-100 text-red-700",
};

export function AccountsTable({ accounts, currentUserId, isPrimaryAdmin, loading, selected, onSelectedChange, onDeleteSelected, onRestore, restoringId }: AccountsTableProps) {
	const { t } = useLanguage();
	const isSelectable = (account: AccountsTableProps["accounts"][number]) =>
		!account.isPrimaryAdmin && account.id !== currentUserId && !account.deletedAt && (isPrimaryAdmin || account.role !== "admin");
	const selectable = accounts.filter(isSelectable);
	const allSelected = selectable.length > 0 && selectable.every((account) => selected.has(account.id));

	function toggle(id: string, checked: boolean) {
		const next = new Set(selected);
		if (checked) next.add(id);
		else next.delete(id);
		onSelectedChange(next);
	}

	return <div className="overflow-hidden rounded-3xl bg-white">
		<div className={`${COLUMNS} border-b border-neutral-100 px-5 py-3 text-xs font-medium uppercase text-neutral-500`}>
			<Checkbox aria-label={t("accounts.selectAll")} checked={allSelected} disabled={!selectable.length} onChange={(event) => onSelectedChange(event.target.checked ? new Set(selectable.map((account) => account.id)) : new Set())} />
			<span>{selected.size ? t("common.selectedCount", { count: selected.size }) : t("accounts.colAccount")}</span>
			<span className="hidden md:block">{t("accounts.colStatus")}</span>
			<span className="hidden md:block">{t("accounts.colLastSignIn")}</span>
			<span className="flex justify-end">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild><Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={t("accounts.moreActions")}><MoreVertical className="h-4 w-4" /></Button></DropdownMenu.Trigger>
					<DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-48 rounded-lg border border-neutral-200 bg-white p-1 text-sm normal-case shadow-lg">
						<DropdownMenu.Item disabled={!selected.size} onSelect={onDeleteSelected} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-red-600 outline-none hover:bg-red-50 focus:bg-red-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"><Trash2 className="h-4 w-4" />{t("accounts.deleteSelected")}</DropdownMenu.Item>
					</DropdownMenu.Content></DropdownMenu.Portal>
				</DropdownMenu.Root>
			</span>
		</div>
		{loading && <p className="px-5 py-4 text-sm text-neutral-500">{t("common.loading")}</p>}
		{accounts.map((account) => {
			const locked = !isPrimaryAdmin && account.role === "admin" && account.id !== currentUserId;
			const status = getAccountStatus({ disabled: !!account.disabled, deletedAt: account.deletedAt });
			const statusLabel = status === "pendingDeletion" && account.deletedAt
				? t("accounts.status.pendingDeletion", { date: formatAccountDate(getAccountPurgeDate(new Date(account.deletedAt)).toISOString()) })
				: t(`accounts.status.${status}`);
			const identity = <>
				<span className="min-w-0 flex items-center gap-4">
					<span style={getAvatarColorStyle(account.email)} className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold">{account.name.charAt(0).toUpperCase()}{account.hasAvatar && <ProgressiveAvatarImage src={`/api/accounts/${account.id}/avatar`} alt="" className="absolute inset-0 h-full w-full object-cover" />}</span>
					<span className="min-w-0"><span className="flex items-center gap-2"><span className="truncate font-semibold text-neutral-900">{account.name}</span><span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${account.isPrimaryAdmin ? "bg-amber-100 text-amber-800" : "bg-neutral-100 text-neutral-600"}`}>{account.isPrimaryAdmin ? t("accounts.primaryAdmin") : t(account.role === "admin" ? "accounts.role.admin" : "accounts.role.user")}</span></span><span className="block truncate text-sm text-neutral-500">{account.email}</span></span>
				</span>
				<span className="hidden md:block"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>{statusLabel}</span></span>
				<span className="hidden text-sm text-neutral-500 md:block">{account.lastSignInAt ? formatAccountDateTime(account.lastSignInAt) : t("accounts.neverSignedIn")}</span>
			</>;
			const rowClass = `${COLUMNS} px-5 py-3 border-b border-neutral-100 last:border-b-0`;
			const checkbox = <Checkbox aria-label={t("accounts.selectOne", { name: account.name })} checked={selected.has(account.id)} disabled={!isSelectable(account)} onChange={(event) => toggle(account.id, event.target.checked)} />;
			const restoreButton = !account.deletedAt ? <span /> : <span className="flex justify-end"><Button variant="ghost" size="sm" className="h-7 w-7 p-0" title={t("accounts.restore")} aria-label={t("accounts.restoreAccount", { name: account.name })} disabled={locked || restoringId === account.id} onClick={() => onRestore(account)}><RotateCcw className="h-4 w-4" /></Button></span>;
			if (account.deletedAt) {
				return <div key={account.id} className={`${rowClass} opacity-80`}>{checkbox}<div className="contents">{identity}</div>{restoreButton}</div>;
			}
			if (locked) {
				return <div key={account.id} aria-disabled="true" title={t("accounts.lockedAdmin")} className={`${rowClass} cursor-not-allowed opacity-50`}>{checkbox}<div className="contents">{identity}</div>{restoreButton}</div>;
			}
			return <div key={account.id} className={`${rowClass} hover:bg-neutral-50`}>{checkbox}<Link href={`/accounts/${account.id}`} className="contents">{identity}</Link>{restoreButton}</div>;
		})}
	</div>;
}
