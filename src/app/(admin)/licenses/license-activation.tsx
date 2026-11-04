"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { LicenseStatus } from "@/lib/licenses/types";
import type { ActivatableLicensePlan, LicenseAction } from "./types";
import { formatLicensePlan, loadLicenseStatus, runLicenseAction } from "./utils";

// children is the pricing grid: the activated card goes above it, the key form below.
export function LicenseActivation({ children }: { children?: ReactNode }) {
	const { t } = useLanguage();
	const [license, setLicense] = useState<LicenseStatus | null>(null);
	const [licenseKey, setLicenseKey] = useState("");
	const [selectedPlan, setSelectedPlan] = useState<ActivatableLicensePlan>("pro");
	const [loading, setLoading] = useState(true);
	const [action, setAction] = useState<LicenseAction | null>(null);
	const [status, setStatus] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		loadLicenseStatus()
			.then((nextLicense) => {
				if (!cancelled) setLicense(nextLicense);
			})
			.catch((error) => {
				if (!cancelled) setStatus(error instanceof Error ? error.message : t("licenses.loadFailed"));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function submit(nextAction: LicenseAction) {
		if (nextAction !== "deactivate" && !licenseKey.trim()) {
			setStatus(t("licenses.enterKey"));
			return;
		}
		if (nextAction === "deactivate" && !window.confirm(t("licenses.deactivateConfirm"))) return;

		setAction(nextAction);
		setStatus(null);
		try {
			const nextLicense = await runLicenseAction(nextAction, licenseKey, nextAction === "activate" ? selectedPlan : undefined);
			setLicense(nextLicense);
			setLicenseKey("");
			setStatus(nextAction === "deactivate" ? t("licenses.deactivated") : nextAction === "validate" ? t("licenses.validated") : t("licenses.activated"));
		} catch (error) {
			setStatus(error instanceof Error ? error.message : t("licenses.requestFailed"));
			try {
				setLicense(await loadLicenseStatus());
			} catch {
				// Keep the last visible status when the local status endpoint is unavailable.
			}
		} finally {
			setAction(null);
		}
	}

	if (loading) return <>{children}<Skeleton className="h-64 w-full rounded-3xl" /></>;

	const hasActivation = !!license?.activatedAt && license.state !== "deactivated";

	if (license?.active) {
		return (
			<>
			<Card className="rounded-3xl border-0 bg-white px-6">
				<CardContent className="flex items-start gap-4 py-8">
					<span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
						<CheckCircle2 className="h-6 w-6" />
					</span>
					<div className="min-w-0 flex-1">
						<CardTitle>{t("licenses.activated")}</CardTitle>
						<p className="mt-2 text-sm leading-6 text-neutral-600">
							{t("licenses.activatedBody", { plan: formatLicensePlan(license.plan, t) })}
						</p>
						<p className="mt-1 text-sm text-neutral-500">{license.seatLimit === null ? t("licenses.seatsUnlimited") : t("licenses.seats", { limit: license.seatLimit })}</p>
						<Button type="button" variant="outline" className="mt-5" onClick={() => void submit("deactivate")} disabled={action !== null}>
							{action === "deactivate" ? t("licenses.deactivating") : t("licenses.deactivate")}
						</Button>
						{status && <p role="status" className="mt-3 text-sm text-neutral-500">{status}</p>}
					</div>
				</CardContent>
			</Card>
			{children}
			</>
		);
	}

	return (
		<>
		{children}
		<Card className="rounded-3xl border-0 bg-white px-6">
			<CardContent className="space-y-5 pb-6">
				{hasActivation && license && (
					<p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
						{t("licenses.currentState", { state: license.state })}
					</p>
				)}
				{!hasActivation && (
					<div className="space-y-4 pt-6">
						<Label className="mb-4">{t("licenses.haveLicense")}</Label>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 mt-2" role="radiogroup" aria-label={t("licenses.product")}>
							<button
								type="button"
								role="radio"
								aria-checked={selectedPlan === "pro"}
								onClick={() => setSelectedPlan("pro")}
								disabled={action !== null}
								className={`rounded-2xl border px-4 py-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer ${
									selectedPlan === "pro"
										? "border-blue-600 bg-neutral-50 ring-1 ring-blue-700"
										: "border-neutral-200 bg-white hover:border-neutral-400"
								}`}
							>
								<span className="block text-xl font-semibold">Pro</span>
								<span className="mt-1 block text-xs text-neutral-500">{t("licenses.proTag")}</span>
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={selectedPlan === "team"}
								onClick={() => setSelectedPlan("team")}
								disabled={action !== null}
								className={`rounded-2xl border px-4 py-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer ${
									selectedPlan === "team"
										? "border-blue-600 bg-neutral-50 ring-1 ring-blue-700"
										: "border-neutral-200 bg-white hover:border-neutral-400"
								}`}
							>
								<span className="block text-xl font-semibold text-neutral-900">Team</span>
								<span className="mt-1 block text-xs text-neutral-500">{t("licenses.teamTag")}</span>
							</button>
						</div>
					</div>
				)}
				<div className="space-y-2">
					<Label htmlFor="licenseKey">{t("licenses.licenseKey")}</Label>
					<Input
						id="licenseKey"
						type="password"
						autoComplete="off"
						value={licenseKey}
						onChange={(event) => setLicenseKey(event.target.value)}
						placeholder={t("licenses.keyPlaceholder")}
						disabled={action !== null}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					{hasActivation ? (
						<>
							<Button type="button" onClick={() => void submit("validate")} disabled={action !== null}>
								{action === "validate" ? t("licenses.validating") : t("licenses.validate")}
							</Button>
							<Button type="button" variant="outline" onClick={() => void submit("deactivate")} disabled={action !== null}>
								{action === "deactivate" ? t("licenses.deactivating") : t("licenses.deactivateShort")}
							</Button>
						</>
					) : (
						<Button type="button" onClick={() => void submit("activate")} disabled={action !== null}>
							{action === "activate" ? t("licenses.activating") : t("licenses.activate")}
						</Button>
					)}
					{status && <p role="status" className="text-sm text-neutral-500">{status}</p>}
				</div>
			</CardContent>
		</Card>
		</>
	);
}
