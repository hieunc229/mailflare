"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LockKeyhole } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmPasswordReset } from "./utils";

export function ResetPasswordClient() {
	const { t } = useLanguage();
	const token = useSearchParams().get("token") ?? "";
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [done, setDone] = useState(false);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (password !== confirm) {
			setError(t("auth.reset.mismatch"));
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const result = await confirmPasswordReset(token, password);
			if (!result.ok) {
				setError(result.error ?? t("auth.reset.failed"));
				return;
			}
			setDone(true);
		} catch {
			setError(t("auth.serverUnreachable"));
		} finally {
			setLoading(false);
		}
	}

	if (!token) {
		return (
			<AuthShell icon={LockKeyhole} title={t("auth.reset.linkMissing")} description={t("auth.reset.linkMissingDescription")}>
				<Link href="/forgot-password" className="text-sm text-blue-600 hover:underline">
					{t("auth.reset.requestNew")}
				</Link>
			</AuthShell>
		);
	}

	return (
		<AuthShell
			icon={LockKeyhole}
			title={done ? t("auth.reset.updated") : t("auth.reset.chooseNew")}
			description={
				done
					? t("auth.reset.doneDescription")
					: t("auth.reset.description")
			}
			footer={
				done ? (
					<Link href="/login" className="text-sm font-medium text-blue-600 hover:underline">
						{t("auth.reset.goToSignIn")}
					</Link>
				) : undefined
			}
		>
			{!done && (
				<form onSubmit={onSubmit} className="space-y-5">
					<div className="space-y-2">
						<Label htmlFor="password">{t("auth.reset.newPassword")}</Label>
						<Input
							id="password"
							type="password"
							autoComplete="new-password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							minLength={8}
							required
							autoFocus
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="confirm">{t("auth.reset.confirm")}</Label>
						<Input
							id="confirm"
							type="password"
							autoComplete="new-password"
							value={confirm}
							onChange={(event) => setConfirm(event.target.value)}
							minLength={8}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</p>
					)}
					<Button type="submit" className="h-11 w-full rounded-full px-6 active:scale-[0.98]" disabled={loading}>
						{loading ? t("common.saving") : t("auth.reset.setNew")}
					</Button>
				</form>
			)}
		</AuthShell>
	);
}
