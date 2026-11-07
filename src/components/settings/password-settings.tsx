"use client";

import { useState } from "react";
import { KeyRound } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePassword } from "./utils";
import { authErrorText } from "@/lib/auth/error-messages";
import { ClientRequestError } from "@/lib/http/client-error";
import { removePassword, setPassword } from "./passkey-settings-utils";
import { refreshSecurityStatus, useSecurityStatus } from "./security-status-store";
import { StepUpDialog } from "./step-up-dialog";
import { PasskeyFirstChoice, type PasskeyPolicyChoice } from "./passkey-first-choice";

/**
 * Password controls that understand passkey-only accounts: set one, change it,
 * or remove it once another sign-in method exists.
 */
export function PasswordSettings() {
	const { t } = useLanguage();
	const { status, error: loadFailed } = useSecurityStatus();
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [pending, setPending] = useState<"set" | "remove" | null>(null);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [passwordProof, setPasswordProof] = useState<string | null>(null);

	async function change(event: React.FormEvent) {
		event.preventDefault();
		setMessage(null);
		setError(null);
		if (newPassword !== confirmPassword) {
			setError(t("settings.password.mismatch"));
			return;
		}
		setBusy(true);
		try {
			await updatePassword(currentPassword, newPassword);
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
			setMessage(t("settings.password.changed"));
			await refreshSecurityStatus(true);
		} catch (err) {
			setError(authErrorText(err instanceof ClientRequestError ? err.code : undefined, t, "settings.password.failed"));
		} finally {
			setBusy(false);
		}
	}

	async function authorized(token: string) {
		setError(null);
		if (pending === "set") {
			setPasswordProof(token);
			setPending(null);
			return;
		} else {
			await removePassword(token);
			setMessage(t("passkey.passwordRemoved"));
		}
		await refreshSecurityStatus(true);
		setPending(null);
	}

	async function choosePasswordPolicy(choice: PasskeyPolicyChoice) {
		if (!passwordProof || busy) return;
		if (choice === "passkey-only") {
			setPasswordProof(null);
			setNewPassword("");
			setConfirmPassword("");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await setPassword(newPassword, passwordProof, choice === "password-and-passkey");
			setMessage(t("passkey.passwordSet"));
			setNewPassword("");
			setConfirmPassword("");
			await refreshSecurityStatus(true);
		} catch (err) {
			setError(authErrorText(err instanceof ClientRequestError ? err.code : undefined, t, "settings.password.failed"));
			await refreshSecurityStatus(true);
		} finally {
			setPasswordProof(null);
			setBusy(false);
		}
	}

	if (!status) return <p role={loadFailed ? "alert" : undefined} className="text-sm text-neutral-500">{loadFailed ? t("settings.password.failed") : t("mfa.loading")}</p>;

	return (
		<div className="space-y-4">
			{status.passwordSet ? (
				<form onSubmit={change} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="currentPassword">{t("settings.password.current")}</Label>
						<Input id="currentPassword" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
					</div>
					<div className="space-y-2">
						<Label htmlFor="newPassword">{t("settings.password.new")}</Label>
						<Input id="newPassword" type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
					</div>
					<div className="space-y-2">
						<Label htmlFor="confirmPassword">{t("settings.password.confirm")}</Label>
						<Input id="confirmPassword" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
					</div>
					<div className="flex flex-wrap items-center gap-3">
						<Button type="submit" disabled={busy}>{busy ? t("settings.password.changing") : t("settings.password.change")}</Button>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirmRemove(true)}
							disabled={busy || status.passkeys.length === 0}
							title={status.passkeys.length === 0 ? t("passkey.addBeforeRemovingPassword") : undefined}
						>
							{t("passkey.removePassword")}
						</Button>
					</div>
					{status.passkeys.length === 0 ? (
						<p className="text-xs leading-5 text-neutral-500">{t("passkey.addBeforeRemovingPassword")}</p>
					) : (
						// Without a second step the password is the weakest factor, so the
						// passkey-only account is the better one.
						!status.requireSecondFactor && (
							<p className="text-xs leading-5 text-neutral-500">{t("passkey.removePasswordRecommended")}</p>
						)
					)}
				</form>
			) : (
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						setError(null);
						if (newPassword !== confirmPassword) {
							setError(t("settings.password.mismatch"));
							return;
						}
						setPending("set");
					}}
				>
					<p className="text-sm text-neutral-500">{t("passkey.noPassword")}</p>
					<div className="space-y-2">
						<Label htmlFor="setPassword">{t("settings.password.new")}</Label>
						<Input id="setPassword" type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
					</div>
					<div className="space-y-2">
						<Label htmlFor="setPasswordConfirm">{t("settings.password.confirm")}</Label>
						<Input id="setPasswordConfirm" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
					</div>
					<Button type="submit" disabled={busy}>
						<KeyRound className="h-4 w-4" />
						{t("passkey.setPassword")}
					</Button>
				</form>
			)}

			{message && <p role="status" className="text-sm text-neutral-500">{message}</p>}
			{error && <p role="alert" className="text-sm text-red-600">{error}</p>}

			<Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
				<DialogContent className="sm:max-w-[440px]">
					<DialogHeader>
						<DialogTitle>{t("passkey.removePasswordTitle")}</DialogTitle>
						<DialogDescription>{t("passkey.removePasswordDescription")}</DialogDescription>
					</DialogHeader>
					<p className="mb-4 text-sm leading-6 text-neutral-500">{t("passkey.lostAllHint")}</p>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={() => setConfirmRemove(false)}>
							{t("common.cancel")}
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								setConfirmRemove(false);
								setPending("remove");
							}}
						>
							{t("passkey.removePassword")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			<StepUpDialog
				open={!!pending}
				hasPassword={status.passwordSet}
				hasPasskey={status.passkeys.length > 0}
				requireSecondFactor={status.requireSecondFactor}
				totpEnabled={status.totpEnabled}
				action={pending === "set" ? "password.set" : "password.remove"}
				onOpenChange={(open) => !open && setPending(null)}
				onAuthorized={authorized}
			/>
			<PasskeyFirstChoice
				open={passwordProof !== null}
				context="add-password"
				totpEnabled={status.totpEnabled}
				busy={busy}
				onOpenChange={() => {}}
				onChoose={(choice) => void choosePasswordPolicy(choice)}
			/>
		</div>
	);
}
