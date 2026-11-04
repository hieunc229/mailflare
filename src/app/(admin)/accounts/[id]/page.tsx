"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Upload } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { Label } from "@/components/ui/label";
import type { ManagedAccount } from "./types";
import {
	fetchManagedAccount,
	getManagedAccountAvatarUrl,
	saveManagedAccount,
	uploadManagedAccountAvatar,
} from "./utils";

export default function AccountDetailsPage() {
	const { t } = useLanguage();
	const { id } = useParams<{ id: string }>();
	const [account, setAccount] = useState<ManagedAccount | null>(null);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [avatarVersion, setAvatarVersion] = useState(0);

	useEffect(() => {
		void fetchManagedAccount(id)
			.then(setAccount)
			.catch((error) => setMessage(error instanceof Error ? error.message : t("account.loadFailed")));
	}, [id, t]);

	async function saveDetails() {
		if (!account) return;
		setSaving(true);
		setMessage(null);
		try {
			await saveManagedAccount(account);
			setMessage(t("account.updated"));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : t("account.updateFailed"));
		} finally {
			setSaving(false);
		}
	}

	async function uploadAvatar(file: File | undefined) {
		if (!file || !account) return;
		try {
			await uploadManagedAccountAvatar(account.id, file);
			setAccount({ ...account, hasAvatar: true });
			setAvatarVersion(Date.now());
		} catch (error) {
			setMessage(error instanceof Error ? error.message : t("account.avatarFailed"));
		}
	}

	if (!account) return <p className="text-sm text-neutral-500">{message ?? t("account.loadingAccount")}</p>;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("account.detailsTitle")}</h1>
				<p className="mt-2 text-sm text-neutral-500">{t("account.detailsDescription")}</p>
			</div>
			<section className="space-y-5 rounded-3xl bg-white p-6">
				{!account.editable && (
					<p className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-500">
						{t("account.noPermission")}
					</p>
				)}
				<div className="flex items-center gap-4">
					<span className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-blue-100 text-xl font-semibold text-blue-700">
						{account.name.charAt(0).toUpperCase()}
						{account.hasAvatar && (
							<ProgressiveAvatarImage src={getManagedAccountAvatarUrl(id, avatarVersion)} alt="" className="absolute inset-0 h-full w-full object-cover" />
						)}
					</span>
					{account.editable && (
						<Label className="cursor-pointer">
							<span className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 px-3 text-sm">
								<Upload className="h-4 w-4" />
								{t("account.changeAvatar")}
							</span>
							<Input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" onChange={(event) => void uploadAvatar(event.target.files?.[0])} />
						</Label>
					)}
				</div>
				<div className="space-y-2">
					<Label htmlFor="account-email">{t("auth.email")}</Label>
					<Input id="account-email" value={account.email} readOnly className="bg-neutral-50 text-neutral-500" />
				</div>
				<div className="space-y-2">
					<Label htmlFor="account-name">{t("common.name")}</Label>
					<Input id="account-name" value={account.name} disabled={!account.editable} onChange={(event) => setAccount({ ...account, name: event.target.value })} />
				</div>
				{account.canForwardEmail && <div className="space-y-2">
					<Label htmlFor="forwarding-email">{t("account.forwardingOptional")}</Label>
					<Input
						id="forwarding-email"
						type="email"
						value={account.forwardingEmail ?? ""}
						disabled={!account.editable}
						onChange={(event) => setAccount({ ...account, forwardingEmail: event.target.value || null })}
						placeholder="destination@example.com"
					/>
					<p className="text-xs leading-5 text-neutral-500">
						{t("settings.forwarding.hint")}
					</p>
				</div>}
				<div className="flex items-center justify-between gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
					<div className="space-y-1">
						<Label htmlFor="account-enabled" className="font-semibold text-neutral-900">{t("account.enabled")}</Label>
						<p id="account-enabled-description" className="text-xs leading-5 text-neutral-500">
							{account.isPrimaryAdmin ? t("account.primaryAlwaysEnabled") : t("account.allowSignIn")}
						</p>
					</div>
					<Switch
						id="account-enabled"
						aria-describedby="account-enabled-description"
						checked={!account.disabled}
						disabled={saving || !account.editable || account.isPrimaryAdmin}
						onCheckedChange={(enabled) => setAccount({ ...account, disabled: !enabled })}
					/>
				</div>
				{account.editable && (
					<Button onClick={() => void saveDetails()} disabled={saving || !account.name.trim()}>
						{saving ? t("common.saving") : t("account.saveDetails")}
					</Button>
				)}
			</section>
			{message && <p role="status" className="text-sm text-neutral-500">{message}</p>}
		</div>
	);
}
