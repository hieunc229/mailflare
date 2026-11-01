"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { useCurrentUser, clearCurrentUserCache } from "@/hooks/use-current-user";
import type { ManagedAccount } from "../types";
import {
	fetchManagedAccount,
	fetchTransferCandidates,
	saveManagedAccount,
	transferPrimaryAdmin,
	type TransferCandidate,
} from "../utils";

export default function AccountPermissionsPage() {
	const { t } = useLanguage();
	const { id } = useParams<{ id: string }>();
	const currentUser = useCurrentUser();
	const [account, setAccount] = useState<ManagedAccount | null>(null);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [candidates, setCandidates] = useState<TransferCandidate[]>([]);
	const [transferTargetId, setTransferTargetId] = useState("");
	const [transferOpen, setTransferOpen] = useState(false);
	const [transferring, setTransferring] = useState(false);

	useEffect(() => {
		void fetchManagedAccount(id)
			.then(setAccount)
			.catch((error) => setMessage(error instanceof Error ? error.message : t("account.permissions.loadFailed")));
	}, [id, t]);

	const isPrimary = !!account?.canChangeRole;
	const transferTarget = useMemo(
		() => candidates.find((candidate) => candidate.id === transferTargetId) ?? null,
		[candidates, transferTargetId],
	);

	useEffect(() => {
		if (!isPrimary) return;
		void fetchTransferCandidates()
			.then((list) => setCandidates(list.filter((candidate) => candidate.id !== currentUser?.id && !candidate.disabled)))
			.catch(() => undefined);
	}, [isPrimary, currentUser?.id]);

	async function savePermissions() {
		if (!account) return;
		setSaving(true);
		setMessage(null);
		try {
			await saveManagedAccount(account);
			// Editing your own flags changes what your navigation shows; drop the cached user.
			if (currentUser?.id === account.id) clearCurrentUserCache();
			setMessage(t("account.permissions.updated"));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : t("account.permissions.updateFailed"));
		} finally {
			setSaving(false);
		}
	}

	async function confirmTransfer() {
		if (!transferTarget) return;
		setTransferring(true);
		setMessage(null);
		try {
			await transferPrimaryAdmin(transferTarget.id);
			clearCurrentUserCache();
			setTransferOpen(false);
			// A full reload drops the stale cached session so the navigation reflects the new role.
			window.location.assign(`/accounts/${transferTarget.id}/permissions`);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : t("account.permissions.transferFailed"));
			setTransferring(false);
		}
	}

	const editable = !!account?.editable;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("account.permissions.title")}</h1>
				<p className="mt-2 text-sm text-neutral-500">{t("account.permissions.description")}</p>
			</div>
			{account?.isPrimaryAdmin && (
				<section className="rounded-3xl bg-amber-50 p-6">
					<p className="text-sm font-semibold text-amber-900">{t("account.permissions.primaryAdmin")}</p>
					<p className="mt-1 text-sm text-amber-800">{t("account.permissions.primaryNote")}</p>
				</section>
			)}
			<section className="space-y-3 rounded-3xl bg-white p-6">
				<label htmlFor="account-role" className="block text-sm font-semibold text-neutral-900">{t("accounts.role")}</label>
				<Select
					id="account-role"
					value={account?.role ?? "user"}
					disabled={!account || saving || !account.canChangeRole}
					containerClassName="w-full sm:w-64"
					className="h-10 text-sm"
					onChange={(event) => account && setAccount({ ...account, role: event.target.value === "admin" ? "admin" : "user" })}
				>
					<option value="user">{t("accounts.roleUser")}</option>
					<option value="admin">{t("accounts.roleAdmin")}</option>
				</Select>
				<p className="text-xs text-neutral-500">
					{account?.canChangeRole
						? t("account.permissions.admins")
						: t("account.permissions.onlyPrimaryRoles")}
				</p>
			</section>
			<div className="overflow-hidden rounded-3xl bg-white">
				<table className="w-full text-left">
					<thead className="border-b border-neutral-100 bg-neutral-50 text-xs font-semibold uppercase tracking-wide text-neutral-500">
						<tr>
							<th scope="col" className="px-5 py-3">{t("account.permissions.permission")}</th>
							<th scope="col" className="w-28 px-5 py-3 text-center">{t("account.permissions.allowed")}</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-100">
						<tr>
							<td className="px-5 py-4">
								<p className="text-sm font-semibold text-neutral-900">{t("account.permissions.manageMailboxes")}</p>
								<p className="mt-1 text-xs text-neutral-500">{t("account.permissions.manageMailboxesHint")}</p>
							</td>
							<td className="px-5 py-4 text-center">
								<Checkbox
									aria-label={t("account.permissions.allowMailboxes")}
									checked={account?.canManageMailboxes ?? false}
									disabled={!account || !editable}
									onChange={(event) => account && setAccount({ ...account, canManageMailboxes: event.target.checked })}
								/>
							</td>
						</tr>
						<tr>
							<td className="px-5 py-4">
								<p className="text-sm font-semibold text-neutral-900">{t("account.permissions.manageDomains")}</p>
								<p className="mt-1 text-xs text-neutral-500">{t("account.permissions.manageDomainsHint")}</p>
							</td>
							<td className="px-5 py-4 text-center">
								<Checkbox
									aria-label={t("account.permissions.allowDomains")}
									checked={account?.canManageDomains ?? false}
									disabled={!account || !account.canChangeRole}
									onChange={(event) => account && setAccount({ ...account, canManageDomains: event.target.checked })}
								/>
							</td>
						</tr>
						<tr>
							<td className="px-5 py-4">
								<p className="text-sm font-semibold text-neutral-900">{t("account.permissions.manageUsers")}</p>
								<p className="mt-1 text-xs text-neutral-500">{t("account.permissions.manageUsersHint")}</p>
							</td>
							<td className="px-5 py-4 text-center">
								<Checkbox
									aria-label={t("account.permissions.allowUsers")}
									checked={account?.canManageUsers ?? false}
									disabled={!account || !account.canChangeRole}
									onChange={(event) => account && setAccount({ ...account, canManageUsers: event.target.checked })}
								/>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
			<section className="overflow-hidden rounded-3xl bg-white">
				<div className="border-b border-neutral-100 bg-neutral-50 px-5 py-3">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{t("account.permissions.features")}</h2>
					<p className="mt-1 text-xs text-neutral-500">{t("account.permissions.featuresHint")}</p>
				</div>
				<table className="w-full text-left">
					<tbody className="divide-y divide-neutral-100">
						<tr>
							<td className="px-5 py-4">
								<p className="text-sm font-semibold text-neutral-900">{t("account.calendar")}</p>
								<p className="mt-1 text-xs text-neutral-500">{t("account.permissions.calendarHint")}</p>
							</td>
							<td className="w-28 px-5 py-4 text-center">
								<Checkbox
									aria-label={t("account.permissions.allowCalendar")}
									checked={account?.calendarEnabled ?? true}
									disabled={!account || !editable}
									onChange={(event) => account && setAccount({ ...account, calendarEnabled: event.target.checked })}
								/>
							</td>
						</tr>
						<tr>
							<td className="px-5 py-4">
								<p className="text-sm font-semibold text-neutral-900">{t("account.drive")}</p>
								<p className="mt-1 text-xs text-neutral-500">{t("account.permissions.driveHint")}</p>
							</td>
							<td className="w-28 px-5 py-4 text-center">
								<Checkbox
									aria-label={t("account.permissions.allowDrive")}
									checked={account?.driveEnabled ?? true}
									disabled={!account || !editable}
									onChange={(event) => account && setAccount({ ...account, driveEnabled: event.target.checked })}
								/>
							</td>
						</tr>
					</tbody>
				</table>
			</section>
			{editable && (
				<Button onClick={() => void savePermissions()} disabled={saving}>
					{saving ? t("common.saving") : t("account.permissions.save")}
				</Button>
			)}
			{isPrimary && (
				<section className="space-y-4 rounded-3xl bg-white p-6">
					<div>
						<h2 className="text-sm font-semibold text-neutral-900">{t("account.permissions.transferTitle")}</h2>
						<p className="mt-1 text-xs text-neutral-500">{t("account.permissions.transferHint")}</p>
					</div>
					<div className="flex flex-col gap-3 sm:flex-row">
						<Select
							aria-label={t("account.permissions.selectNext")}
							value={transferTargetId}
							containerClassName="w-full sm:max-w-sm"
							className="h-10 text-sm"
							onChange={(event) => setTransferTargetId(event.target.value)}
						>
							<option value="">{t("account.permissions.selectAccount")}</option>
							{candidates.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>{candidate.email} — {candidate.name}</option>
							))}
						</Select>
						<Button variant="outline" disabled={!transferTarget} onClick={() => setTransferOpen(true)}>
							{t("account.permissions.transferTitle")}
						</Button>
					</div>
				</section>
			)}
			{message && <p role="status" className="text-sm text-neutral-500">{message}</p>}

			<Dialog open={transferOpen} onOpenChange={setTransferOpen}>
				<DialogContent className="w-[min(420px,calc(100vw-32px))]">
					<DialogHeader>
						<DialogTitle>{t("account.permissions.transferQuestion")}</DialogTitle>
						<DialogDescription>
							{t("account.permissions.transferWarning")}
						</DialogDescription>
					</DialogHeader>
					{transferTarget && (
						<div className="flex items-center gap-4 rounded-2xl border border-neutral-200 p-4">
							<span
								className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white"
								style={getAvatarColorStyle(transferTarget.email)}
							>
								{transferTarget.name.charAt(0).toUpperCase()}
								{transferTarget.hasAvatar && (
									<ProgressiveAvatarImage
										src={`/api/accounts/${transferTarget.id}/avatar`}
										alt=""
										className="absolute inset-0 h-full w-full object-cover"
									/>
								)}
							</span>
							<span className="min-w-0">
								<span className="block truncate font-semibold text-neutral-900">{transferTarget.name}</span>
								<span className="block truncate text-sm text-neutral-500">{transferTarget.email}</span>
							</span>
						</div>
					)}
					<div className="flex justify-end gap-2">
						<DialogClose asChild>
							<Button variant="outline" disabled={transferring}>{t("common.cancel")}</Button>
						</DialogClose>
						<Button disabled={transferring || !transferTarget} onClick={() => void confirmTransfer()}>
							{transferring ? t("account.permissions.transferring") : t("account.permissions.confirmTransfer")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
