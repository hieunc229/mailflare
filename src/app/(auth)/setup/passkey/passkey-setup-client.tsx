"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KeyRound } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { authErrorText } from "@/lib/auth/error-messages";
import { isPasskeyCancellation, isPasskeyUnsupported } from "@/lib/auth/webauthn/browser-errors";
import { finishPasskeySetup, loadPasskeySetupContext, startPasskeySetup } from "./utils";
import type { PasskeySetupContext } from "./types";

export function PasskeySetupClient({ token }: { token: string }) {
	const { t } = useLanguage();
	const router = useRouter();
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [linkError, setLinkError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [checking, setChecking] = useState(Boolean(token));
	const [email, setEmail] = useState<string | null>(null);
	const [kind, setKind] = useState<PasskeySetupContext["kind"]>(undefined);

	useEffect(() => {
		if (!token) return;
		let cancelled = false;
		void loadPasskeySetupContext(token)
			.then(({ ok, data }) => {
				if (cancelled) return;
				if (!ok) setLinkError(authErrorText(data.code, t, "authError.setupInvalid"));
				else {
					setEmail(data.email ?? null);
					setKind(data.kind);
				}
			})
			.catch(() => {
				if (!cancelled) setLinkError(t("authError.setupInvalid"));
			})
			.finally(() => {
				if (!cancelled) setChecking(false);
			});
		return () => {
			cancelled = true;
		};
	}, [token, t]);

	async function createPasskey(event: React.FormEvent) {
		event.preventDefault();
		setLoading(true);
		setError(null);
		try {
			if (!browserSupportsWebAuthn()) {
				setError(t("passkey.browserUnsupported"));
				return;
			}
			const started = await startPasskeySetup(token);
			if (!started.options || !started.ceremonyToken) {
				setLinkError(authErrorText(started.code, t, "authError.setupInvalid"));
				return;
			}
			const response = await startRegistration({ optionsJSON: started.options as Parameters<typeof startRegistration>[0]["optionsJSON"] });
			const result = await finishPasskeySetup({ token, ceremonyToken: started.ceremonyToken, response, name });
			if (!result.ok) {
				setError(authErrorText(result.data.code, t, "authError.passkeyInvalid"));
				return;
			}
			router.replace(result.data.redirect ?? "/inbox");
			router.refresh();
		} catch (err) {
			if (isPasskeyCancellation(err)) setError(t("authError.passkeyCancelled"));
			else if (isPasskeyUnsupported(err)) setError(t("passkey.browserUnsupported"));
			else setError(t("authError.passkeyInvalid"));
		} finally {
			setLoading(false);
		}
	}

	if (!token) {
		return (
			<AuthShell icon={KeyRound} title={t("passkey.setupTitle")} description={t("passkey.setupDescription")}>
				<p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
					{t("authError.setupInvalid")}
				</p>
			</AuthShell>
		);
	}

	// A recovery link replaces the account's old sign-in methods; a first-run
	// link only adds the first passkey.
	const isRecovery = kind === "recovery" || kind === "admin";

	return (
		<AuthShell
			icon={KeyRound}
			title={email ? t("passkey.setupFor", { email }) : t("passkey.setupTitle")}
			description={
				email
					? isRecovery
						? t("passkey.setupRecoveryDescription")
						: t("passkey.setupAccountDescription")
					: t("passkey.setupDescription")
			}
		>
			{checking ? (
				<p className="text-sm text-neutral-500">{t("common.loading")}</p>
			) : linkError ? (
				<div className="space-y-4">
					<p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
						{linkError}
					</p>
					<p className="text-sm leading-6 text-neutral-500">{t("passkey.setupLinkHelp")}</p>
				</div>
			) : (
				<form onSubmit={createPasskey} className="space-y-5">
					<div className="space-y-2">
						<Label htmlFor="passkey-name">{t("passkey.nameOptional")}</Label>
						<Input
							id="passkey-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={100}
							autoComplete="off"
							placeholder={t("passkey.namePlaceholder")}
							autoFocus
						/>
						<p className="text-xs leading-5 text-neutral-500">{t("passkey.nameHint")}</p>
					</div>
					{error && (
						<p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
							{error}
						</p>
					)}
					<Button type="submit" className="h-11 w-full rounded-full px-6 active:scale-[0.98]" disabled={loading}>
						{loading ? t("passkey.waiting") : t("passkey.create")}
					</Button>
					<p className="text-xs leading-5 text-neutral-500">{t("passkey.createHint")}</p>
				</form>
			)}
		</AuthShell>
	);
}
