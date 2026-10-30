"use client";

import { useEffect, useRef, useState } from "react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { AlertTriangle, CheckCircle2, KeyRound, Pencil, Plus, ShieldCheck, ShieldOff, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PasskeySummary } from "./passkey-settings-types";
import { addPasskey, checkPasskey, passkeyProvider, removePasskey, renamePasskey, removePassword, setSecondFactorRequirement } from "./passkey-settings-utils";
import { PasskeyFirstChoice, type PasskeyPolicyChoice } from "./passkey-first-choice";
import { disableMfa } from "./utils";
import { refreshSecurityStatus, useSecurityStatus } from "./security-status-store";
import { StepUpDialog } from "./step-up-dialog";
import { authErrorText } from "@/lib/auth/error-messages";
import { isPasskeyCancellation, isPasskeyUnsupported } from "@/lib/auth/webauthn/browser-errors";
import { ClientRequestError } from "@/lib/http/client-error";
import type { StepUpAction } from "@/lib/auth/webauthn/step-up-types";

/** The security changes the first-passkey choice can ask for, in order. */
type PolicyStep = "mfa.disable" | "password.remove" | "second_factor.toggle";

type PendingAction =
	| { type: "add"; name: string; first: boolean; hadPassword: boolean }
	| { type: "remove"; id: string; name: string }
	| { type: "policy"; steps: PolicyStep[]; index: number };

export function PasskeySettings() {
	const { t } = useLanguage();
	const { status, error: loadFailed } = useSecurityStatus();
	const [addOpen, setAddOpen] = useState(false);
	const [name, setName] = useState("");
	const [pending, setPending] = useState<PendingAction | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null);
	const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
	const [renameError, setRenameError] = useState<string | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [checking, setChecking] = useState(false);
	const [checkedId, setCheckedId] = useState<string | null>(null);
	const [checkError, setCheckError] = useState<string | null>(null);
	const [choiceOpen, setChoiceOpen] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	/** Set when the step that just finished enrolled the first passkey. */
	const choiceAfterAdd = useRef(false);

	// Keep the recognition badge long enough to notice, then return the list to
	// its resting state without another click.
	useEffect(() => {
		if (!checkedId) return;
		const timer = window.setTimeout(() => setCheckedId(null), 10_000);
		return () => window.clearTimeout(timer);
	}, [checkedId]);

	function displayName(passkey: PasskeySummary) {
		if (passkey.name.trim()) return passkey.name;
		return passkeyProvider(passkey.aaguid) ?? t("passkey.defaultName", { date: new Date(passkey.createdAt).toLocaleDateString() });
	}

	async function onCheck() {
		if (!browserSupportsWebAuthn()) {
			setCheckError(t("passkey.browserUnsupported"));
			return;
		}
		setChecking(true);
		setCheckError(null);
		setCheckedId(null);
		try {
			const id = await checkPasskey();
			setCheckedId(id);
			await refreshSecurityStatus(true);
		} catch (error) {
			if (isPasskeyCancellation(error)) return;
			if (isPasskeyUnsupported(error)) setCheckError(t("passkey.browserUnsupported"));
			else setCheckError(authErrorText(error instanceof ClientRequestError ? error.code : undefined, t, "passkey.verifyFailed"));
		} finally {
			setChecking(false);
		}
	}

	/**
	 * Runs the confirmed change. Returning true keeps the step-up dialog open
	 * for the next step of the same flow.
	 */
	async function authorized(token: string): Promise<boolean> {
		if (!pending) return false;
		try {
			if (pending.type === "add") {
				await addPasskey(pending.name, token);
				setName("");
				await refreshSecurityStatus(true);
				choiceAfterAdd.current = pending.first && pending.hadPassword;
			} else if (pending.type === "remove") {
				await removePasskey(pending.id, token);
				await refreshSecurityStatus(true);
			} else {
				const step = pending.steps[pending.index];
				if (step === "mfa.disable") {
					await disableMfa({ stepUpToken: token });
					await refreshSecurityStatus(true);
					setNotice(t("passkey.authenticatorOffNotice"));
				} else if (step === "password.remove") {
					await removePassword(token);
					await refreshSecurityStatus(true);
				} else {
					await setSecondFactorRequirement(true, token);
					await refreshSecurityStatus(true);
				}
				if (pending.index + 1 < pending.steps.length) {
					setPending({ ...pending, index: pending.index + 1 });
					return true;
				}
			}
		} catch (error) {
			// The server may have applied part of the change; re-read the state
			// before the dialog offers another attempt.
			await refreshSecurityStatus(true);
			throw error;
		}
		return false;
	}

	function choose(choice: PasskeyPolicyChoice) {
		setChoiceOpen(false);
		if (choice === "keep") return;
		if (choice === "password-and-passkey") {
			setPending({ type: "policy", steps: ["second_factor.toggle"], index: 0 });
			return;
		}
		// The authenticator goes first so the password removal leaves no
		// second-factor requirement behind.
		const steps: PolicyStep[] = status?.totpEnabled ? ["mfa.disable", "password.remove"] : ["password.remove"];
		setPending({ type: "policy", steps, index: 0 });
	}

	async function submitRename(event: React.FormEvent) {
		event.preventDefault();
		if (!rename) return;
		setRenaming(true);
		setRenameError(null);
		try {
			await renamePasskey(rename.id, rename.name);
			setRename(null);
			await refreshSecurityStatus(true);
		} catch (err) {
			setRenameError(authErrorText(err instanceof ClientRequestError ? err.code : undefined, t, "passkey.renameFailed"));
		} finally {
			setRenaming(false);
		}
	}

	if (!status) return <p role={loadFailed ? "alert" : undefined} className="text-sm text-neutral-500">{loadFailed ? t("passkey.loadFailed") : t("mfa.loading")}</p>;

	// Password accounts can fall back to password sign-in; passkey-only accounts cannot.
	const canRemove = status.passkeys.length > 1 || status.passwordSet;
	const warnsLastSecondFactor =
		status.passkeys.length === 1 && status.passwordSet && status.requireSecondFactor && !status.totpEnabled;
	const checkedPasskey = checkedId ? status.passkeys.find((passkey) => passkey.id === checkedId) ?? null : null;

	const policy = pending?.type === "policy" ? pending : null;
	const policyStep = policy ? policy.steps[policy.index] : null;
	const stepUpAction: StepUpAction = pending?.type === "add"
		? "passkey.add"
		: pending?.type === "remove"
			? "passkey.remove"
			: policyStep ?? "passkey.add";
	const stepUpTitle = policy
		? policyStep === "mfa.disable"
			? t("mfa.turnOffTitle")
			: policyStep === "password.remove"
				? t("passkey.removePasswordTitle")
				: t("twoStep.requireTitle")
		: undefined;
	const stepUpDescription = policy
		? policyStep === "mfa.disable"
			? t("mfa.turnOffDescription")
			: policyStep === "password.remove"
				? t("passkey.removePasswordDescription")
				: t("twoStep.requireDescription")
		: undefined;

	return (
		<div className="space-y-5">
			<div className="rounded-2xl bg-neutral-50 p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex min-w-0 items-start gap-3">
						{status.passkeys.length > 0 ? (
							<ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
						) : (
							<ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-neutral-400" />
						)}
						<p className="text-sm font-medium text-neutral-900">
							{status.passkeys.length === 0 ? t("passkey.none") : t("passkey.count", { count: status.passkeys.length })}
						</p>
					</div>
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						{status.passkeys.length > 0 && (
							<Button type="button" variant="outline" onClick={() => void onCheck()} disabled={checking}>
								<CheckCircle2 className="h-4 w-4" />
								{checking ? t("common.pleaseWait") : t("passkey.check")}
							</Button>
						)}
						<Button type="button" onClick={() => setAddOpen(true)}>
							<Plus className="h-4 w-4" />
							{t("passkey.add")}
						</Button>
					</div>
				</div>
				{checkError && <p role="alert" className="mt-3 text-sm text-red-600">{checkError}</p>}
				{checkedPasskey && (
					<p role="status" aria-live="polite" className="sr-only">
						{t("passkey.justVerified")}: {displayName(checkedPasskey)}
					</p>
				)}
			</div>

			{notice && <p role="status" className="text-sm text-neutral-500">{notice}</p>}

			{status.passkeys.length > 0 && (
				<ul className="divide-y divide-neutral-100 rounded-2xl border border-neutral-100">
					{status.passkeys.map((passkey) => (
						<li
							key={passkey.id}
							className={`flex items-center justify-between gap-4 px-4 py-3 transition-colors ${checkedId === passkey.id ? "bg-green-50/70" : ""}`}
						>
							<div className="flex min-w-0 items-start gap-3">
								<KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<p className="truncate text-sm font-medium text-neutral-900" title={displayName(passkey)}>{displayName(passkey)}</p>
										{checkedId === passkey.id && (
											<span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
												<CheckCircle2 className="h-3 w-3" />
												{t("passkey.justVerified")}
											</span>
										)}
									</div>
									<p className="mt-1 text-xs text-neutral-500">
										{passkey.lastUsedAt
											? t("passkey.lastUsed", { date: new Date(passkey.lastUsedAt).toLocaleString() })
											: t("passkey.neverUsed")}
										{" · "}
										{passkey.backedUp ? t("passkey.backedUp") : t("passkey.deviceOnly")}
									</p>
									<p className="mt-0.5 text-xs text-neutral-400">{t("passkey.createdAt", { date: new Date(passkey.createdAt).toLocaleDateString() })}</p>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										setRenameError(null);
										setRename({ id: passkey.id, name: displayName(passkey) });
									}}
									aria-label={t("passkey.renameLabel", { name: displayName(passkey) })}
								>
									<Pencil className="h-4 w-4" />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={!canRemove}
									title={canRemove ? undefined : t("passkey.lastMethodHint")}
									onClick={() => setConfirmRemove({ id: passkey.id, name: displayName(passkey) })}
									aria-label={t("passkey.removeLabel", { name: displayName(passkey) })}
								>
									<Trash2 className="h-4 w-4" />
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}

			<Dialog open={addOpen} onOpenChange={setAddOpen}>
				<DialogContent className="sm:max-w-[440px]">
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							setAddOpen(false);
							setPending({
								type: "add",
								name: name.trim(),
								first: status.passkeys.length === 0,
								hadPassword: status.passwordSet,
							});
						}}
					>
						<DialogHeader>
							<DialogTitle>{t("passkey.addTitle")}</DialogTitle>
							<DialogDescription>{t("passkey.addDescription")}</DialogDescription>
						</DialogHeader>
						<div className="space-y-2">
							<Label htmlFor="new-passkey-name">{t("passkey.nameOptional")}</Label>
							<Input
								id="new-passkey-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={100}
								autoComplete="off"
								placeholder={t("passkey.namePlaceholder")}
								autoFocus
							/>
							<p className="text-xs leading-5 text-neutral-500">{t("passkey.nameHint")}</p>
						</div>
						<Button type="submit">{t("common.continue")}</Button>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog open={!!confirmRemove} onOpenChange={(open) => !open && setConfirmRemove(null)}>
				<DialogContent className="sm:max-w-[440px]">
					<DialogHeader>
						<DialogTitle>{t("passkey.removeTitle")}</DialogTitle>
						<DialogDescription>{t("passkey.removeDescription", { name: confirmRemove?.name ?? "" })}</DialogDescription>
					</DialogHeader>
					{warnsLastSecondFactor && (
						<p
							role="alert"
							className="mb-4 flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-5 text-amber-800"
						>
							<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
							<span className="min-w-0">{t("passkey.removeLastSecondFactorWarning")}</span>
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={() => setConfirmRemove(null)}>
							{t("common.cancel")}
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								if (!confirmRemove) return;
								const action = confirmRemove;
								setConfirmRemove(null);
								setPending({ type: "remove", ...action });
							}}
						>
							{t("passkey.remove")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			<Dialog open={!!rename} onOpenChange={(open) => !open && setRename(null)}>
				<DialogContent className="sm:max-w-[440px]">
					<form onSubmit={submitRename} className="space-y-4">
						<DialogHeader>
							<DialogTitle>{t("passkey.renameTitle")}</DialogTitle>
							<DialogDescription>{t("passkey.renameDescription")}</DialogDescription>
						</DialogHeader>
						<div className="space-y-2">
							<Label htmlFor="rename-passkey">{t("passkey.name")}</Label>
							<Input
								id="rename-passkey"
								value={rename?.name ?? ""}
								onChange={(event) => rename && setRename({ ...rename, name: event.target.value })}
								maxLength={100}
								required
								autoFocus
							/>
						</div>
						{renameError && <p role="alert" className="text-sm text-red-600">{renameError}</p>}
						<Button type="submit" disabled={renaming}>{renaming ? t("common.pleaseWait") : t("common.save")}</Button>
					</form>
				</DialogContent>
			</Dialog>

			<PasskeyFirstChoice
				open={choiceOpen}
				totpEnabled={status.totpEnabled}
				onOpenChange={setChoiceOpen}
				onChoose={choose}
			/>

			<StepUpDialog
				open={!!pending}
				hasPassword={status.passwordSet}
				hasPasskey={status.passkeys.length > 0}
				requireSecondFactor={status.requireSecondFactor}
				totpEnabled={status.totpEnabled}
				action={stepUpAction}
				title={stepUpTitle}
				description={stepUpDescription}
				step={policy && policy.steps.length > 1 ? { current: policy.index + 1, total: policy.steps.length } : undefined}
				onOpenChange={(open) => {
					if (open) return;
					setPending(null);
					if (!choiceAfterAdd.current) return;
					choiceAfterAdd.current = false;
					setChoiceOpen(true);
				}}
				onAuthorized={authorized}
			/>
		</div>
	);
}
