"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, LoaderCircle, MailPlus } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { checkDomain, createDomain, createMailbox, getDomains } from "./utils";
import type { DomainPreflight } from "./types";

export function OnboardingClient() {
	const { t } = useLanguage();
	const router = useRouter();
	const [step, setStep] = useState<1 | 2>(1);
	const [hostname, setHostname] = useState("");
	const [domainCheck, setDomainCheck] = useState<DomainPreflight | null>(null);
	const [domainChecking, setDomainChecking] = useState(false);
	const [enableSending, setEnableSending] = useState(false);
	const [skipDns, setSkipDns] = useState(false);
	const [domainId, setDomainId] = useState("");
	const [localPart, setLocalPart] = useState("me");
	const [error, setError] = useState<string | null>(null);
	const [mxConflict, setMxConflict] = useState(false);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		void getDomains()
			.then((data) => {
				const primary = data.domains?.[0];
				if (!primary) return;
				setDomainId(primary.id);
				setHostname(primary.hostname);
				setStep(2);
			})
			.catch(() => undefined);
	}, []);

	async function addDomain(replaceMxRecords = false) {
		setLoading(true);
		setError(null);

		const normalized = hostname.toLowerCase().trim();
		let checkedDomain = domainCheck;
		let sendingRequested = enableSending;
		if (skipDns) {
			checkedDomain = { hostname: normalized, zone: { id: "manual", name: normalized } };
		} else if (checkedDomain?.hostname !== normalized) {
			const result = await checkDomain(normalized);
			if (!result.ok || !result.domain) {
				setLoading(false);
				setError(result.error ?? t("onboarding.domainCheckFailed"));
				return;
			}
			checkedDomain = result.domain;
			sendingRequested = false;
			setDomainCheck(result.domain);
			setEnableSending(sendingRequested);
		}
		if (!checkedDomain) {
			setLoading(false);
			setError(t("onboarding.domainCheckFailed"));
			return;
		}

		const { ok, data } = await createDomain(checkedDomain.hostname, skipDns ? true : sendingRequested, replaceMxRecords, skipDns);
		setLoading(false);
		if (!ok || !data.domain) {
			if (data.code === "MX_RECORDS_CONFLICT") {
				setMxConflict(true);
				setError(null);
				return;
			}
			setError(data.error ?? t("onboarding.addDomainFailed"));
			return;
		}
		setMxConflict(false);
		setDomainId(data.domain.id);
		setStep(2);
	}

	async function inspectDomain() {
		const normalized = hostname.toLowerCase().trim();
		if (skipDns || normalized.length < 3 || domainCheck?.hostname === normalized) return;

		setDomainChecking(true);
		setError(null);
		setMxConflict(false);
		const result = await checkDomain(normalized);
		setDomainChecking(false);
		if (!result.ok || !result.domain) {
			setDomainCheck(null);
			setEnableSending(false);
			setError(result.error ?? t("onboarding.domainCheckFailed"));
			return;
		}

		setDomainCheck(result.domain);
		setEnableSending(false);
	}

	async function addMailbox() {
		setLoading(true);
		setError(null);

		const { ok, data } = await createMailbox(domainId, localPart);
		setLoading(false);
		if (!ok) {
			setError(data.error ?? t("onboarding.createMailboxFailed"));
			return;
		}
		router.push("/inbox");
	}

	return (
		<AuthShell
			icon={MailPlus}
			title={step === 1 ? t("onboarding.connectTitle") : t("onboarding.firstMailboxTitle")}
			description={
				step === 1
					? t("onboarding.connectDescription")
					: t("onboarding.mailboxDescription")
			}
			steps={[
				{ label: t("onboarding.stepDomain"), active: step === 1 },
				{ label: t("onboarding.stepMailbox"), active: step === 2 },
			]}
			footer={
				<span className="inline-flex items-center gap-2 text-neutral-500">
					{t("onboarding.completesInInbox")}
					<ArrowRight className="h-4 w-4" />
				</span>
			}
		>
			<div className="space-y-5">
				{step === 1 && (
					<>
						<p className="rounded-2xl bg-[#eaf1fb] px-4 py-3 text-sm leading-6 text-neutral-700">
							{t("onboarding.cloudflareDns", { token: "\u0001" }).split("\u0001").flatMap((part, index) => index === 0 ? [part] : [<code key={index} className="no-font-mono text-xs font-semibold text-blue-800">CF_TOKEN</code>, part])}
						</p>
						<div className="space-y-2">
							<Label htmlFor="domain">{t("onboarding.domain")}</Label>
							<Input
								id="domain"
								value={hostname}
								onChange={(e) => {
									setHostname(e.target.value);
									if (domainCheck?.hostname !== e.target.value.toLowerCase().trim()) {
										setDomainCheck(null);
										setEnableSending(false);
										setMxConflict(false);
									}
								}}
								onBlur={() => void inspectDomain()}
								placeholder="example.com"
							/>
						</div>
						<div className="flex items-center justify-between gap-4 rounded-2xl bg-neutral-50 px-4 py-3">
							<div>
								<Label htmlFor="onboarding-skip-dns">{t("setup.skipDns")}</Label>
								<p className="mt-1 text-xs leading-5 text-neutral-500">
									{skipDns ? t("setup.skipDnsOn") : t("setup.skipDnsHint")}
								</p>
							</div>
							<Switch
								id="onboarding-skip-dns"
								checked={skipDns}
								onCheckedChange={(checked) => {
									setSkipDns(checked);
									setMxConflict(false);
									setError(null);
								}}
							/>
						</div>
						{!skipDns && (
						<div className="flex items-center justify-between gap-4 rounded-2xl bg-neutral-50 px-4 py-3">
							<div>
								<Label htmlFor="onboarding-enable-sending">{t("setup.enableSending")}</Label>
								<p className="mt-1 text-xs leading-5 text-neutral-500">
									{domainChecking
										? t("setup.checkingCloudflare")
										: domainCheck
											? enableSending
												? t("setup.requiredToSend")
												: t("setup.receiveOnly")
											: t("onboarding.leaveToVerify")}
								</p>
							</div>
							{domainChecking ? (
								<LoaderCircle className="h-4 w-4 animate-spin text-neutral-500" />
							) : (
								<Switch
									id="onboarding-enable-sending"
									checked={enableSending}
									onCheckedChange={setEnableSending}
									disabled={!domainCheck || skipDns}
								/>
							)}
						</div>
						)}
						{domainCheck && !skipDns && (
							<div className="flex items-center gap-3 rounded-2xl bg-green-50 px-4 py-3 text-sm text-green-700">
								<CheckCircle2 className="h-4 w-4" />
								{t("setup.domainFound", { zone: domainCheck.zone.name })}
							</div>
						)}
						{mxConflict && (
							<div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-amber-900">
								<div className="flex items-start gap-3">
									<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
									<p className="text-sm leading-6">
										{t("onboarding.mxConflict")}
									</p>
								</div>
								<Button
									onClick={() => void addDomain(true)}
									disabled={loading}
									className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
								>
									{loading ? t("onboarding.replacingMx") : t("onboarding.deleteMxContinue")}
								</Button>
							</div>
						)}
						{!mxConflict && (
							<Button
								onClick={() => void addDomain()}
								disabled={!hostname || loading || domainChecking}
								className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
							>
								{loading ? t("onboarding.adding") : t("onboarding.addDomain")}
							</Button>
						)}
					</>
				)}
				{step === 2 && (
					<>
						<div className="space-y-2">
							<Label htmlFor="localPart">{t("onboarding.mailboxAddress")}</Label>
							<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
								<Input
									id="localPart"
									value={localPart}
									onChange={(e) => setLocalPart(e.target.value)}
									className="min-w-0"
								/>
								<span className="max-w-36 truncate text-sm font-medium text-neutral-500">@{hostname}</span>
							</div>
						</div>
						<Button
							onClick={addMailbox}
							disabled={!localPart || loading}
							className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
						>
							{loading ? t("setup.creating") : t("onboarding.goToInbox")}
						</Button>
					</>
				)}
				{error && (
					<p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
						{error}
					</p>
				)}
			</div>
		</AuthShell>
	);
}
