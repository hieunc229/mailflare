"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Copy, KeyRound } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepUpDialog } from "@/components/settings/step-up-dialog";
import { loadSecurityStatus } from "@/components/settings/passkey-settings-utils";
import type { SecurityStatus } from "@/components/settings/passkey-settings-types";
import { authFetch } from "@/lib/auth/client";
import { requestError } from "@/lib/http/client-error";
import type { ManagedAccount } from "../types";
import { fetchManagedAccount } from "../utils";
import { saveAccountPassword } from "./utils";

export default function AccountPasswordPage() {
	const { t } = useLanguage();
	const { id } = useParams<{ id: string }>();
	const [account, setAccount] = useState<ManagedAccount | null>(null);
	const [password, setPassword] = useState("");
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [adminSecurity, setAdminSecurity] = useState<SecurityStatus | null>(null);
	const [recoveryOpen, setRecoveryOpen] = useState(false);
	const [pendingRecovery, setPendingRecovery] = useState(false);
	const [pendingReset, setPendingReset] = useState(false);
	const [recoveryLink, setRecoveryLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		void fetchManagedAccount(id)
			.then(setAccount)
			.catch((error) => setMessage(error instanceof Error ? error.message : t("account.loadFailed")));
		void loadSecurityStatus().then(setAdminSecurity).catch(() => undefined);
	}, [id, t]);

	async function createRecoveryLink(stepUpToken: string) {
		const res = await authFetch(`/api/accounts/${id}/recovery`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ stepUpToken }),
		});
		const data = (await res.json()) as { link?: string; error?: string; code?: string };
		if (!res.ok || !data.link) throw requestError(data, t("account.recovery.failed"));
		setRecoveryLink(data.link);
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("account.password.title")}</h1>
				<p className="mt-2 text-sm text-neutral-500">{t("account.password.resetFor", { name: account?.name ?? t("account.password.thisAccount") })}</p>
			</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (account && password.trim().length >= 8) setPendingReset(true);
				}}
				className="space-y-5 rounded-3xl bg-white p-6"
			>
				{account && !account.editable ? (
					<p className="text-sm text-neutral-500">{t("account.password.onlyPrimary")}</p>
				) : account && !account.passwordSet ? (
					<p className="text-sm text-neutral-500">{t("account.recovery.usesPasskeys")}</p>
				) : (
					<>
						<div className="space-y-2">
							<Label htmlFor="account-new-password">{t("account.password.new")}</Label>
							<Input
								id="account-new-password"
								type="password"
								autoComplete="new-password"
								minLength={8}
								maxLength={128}
								required
								value={password}
								disabled={!account || saving}
								onChange={(event) => setPassword(event.target.value)}
								placeholder={t("account.password.placeholder")}
							/>
							<p className="text-xs leading-5 text-neutral-500">
								{t("account.password.hint")}
							</p>
						</div>
						<Button type="submit" disabled={!account || saving || password.trim().length < 8}>
							{saving ? t("account.password.resetting") : t("account.password.reset")}
						</Button>
					</>
				)}
			</form>
			{message && <p role="status" className="text-sm text-neutral-500">{message}</p>}

			{account?.editable && (
				<div className="space-y-3 rounded-3xl border border-neutral-100 bg-white p-6">
					<div>
						<h2 className="text-lg font-semibold text-neutral-900">{t("account.recovery.title")}</h2>
						<p className="mt-1 text-sm text-neutral-500">{t("account.recovery.description")}</p>
					</div>
					<Button type="button" variant="outline" onClick={() => setRecoveryOpen(true)}>
						<KeyRound className="h-4 w-4" />
						{t("account.recovery.create")}
					</Button>
				</div>
			)}

			<Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
				<DialogContent className="sm:max-w-[440px]">
					<DialogHeader>
						<DialogTitle>{t("account.recovery.createTitle")}</DialogTitle>
						<DialogDescription>{t("account.recovery.createDescription")}</DialogDescription>
					</DialogHeader>
					<Button
						onClick={() => {
							setRecoveryOpen(false);
							setPendingRecovery(true);
						}}
					>
						{t("common.continue")}
					</Button>
				</DialogContent>
			</Dialog>

			<StepUpDialog
				open={pendingRecovery}
				hasPassword={adminSecurity?.passwordSet ?? true}
				hasPasskey={(adminSecurity?.passkeys.length ?? 0) > 0}
				requireSecondFactor={adminSecurity?.requireSecondFactor ?? false}
				totpEnabled={adminSecurity?.totpEnabled ?? false}
				action="admin.recovery_link"
				targetUserId={id}
				onOpenChange={(open) => !open && setPendingRecovery(false)}
				onAuthorized={async (token) => {
					await createRecoveryLink(token);
					setCopied(false);
				}}
			/>

			<StepUpDialog
				open={pendingReset}
				hasPassword={adminSecurity?.passwordSet ?? true}
				hasPasskey={(adminSecurity?.passkeys.length ?? 0) > 0}
				requireSecondFactor={adminSecurity?.requireSecondFactor ?? false}
				totpEnabled={adminSecurity?.totpEnabled ?? false}
				action="admin.password_reset"
				targetUserId={id}
				onOpenChange={(open) => !open && setPendingReset(false)}
				onAuthorized={async (token) => {
					await saveAccountPassword({ account, password, stepUpToken: token, setPassword, setSaving, setMessage, t });
					setPendingReset(false);
				}}
			/>

			<Dialog open={!!recoveryLink} onOpenChange={(open) => !open && setRecoveryLink(null)}>
				<DialogContent className="sm:max-w-[520px]">
					<DialogHeader>
						<DialogTitle>{t("account.recovery.createdTitle")}</DialogTitle>
						<DialogDescription>{t("account.recovery.createdDescription")}</DialogDescription>
					</DialogHeader>
					<code className="block break-all rounded-xl bg-neutral-50 p-3 font-mono text-xs text-neutral-800">{recoveryLink}</code>
					<div className="flex items-center gap-3">
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								if (!recoveryLink) return;
								void navigator.clipboard.writeText(recoveryLink).then(() => setCopied(true));
							}}
						>
							<Copy className="h-4 w-4" />
							{copied ? t("common.copied") : t("account.recovery.copy")}
						</Button>
						<Button type="button" onClick={() => setRecoveryLink(null)}>{t("common.done")}</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
