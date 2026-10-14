"use client";

import { confirmAction } from "@/components/ui/installation-dialogs";

import { useEffect, useState, type ReactNode } from "react";
import { useLanguage } from "@/components/language-provider";
import type { TranslationKey } from "@/lib/i18n/types";
import { requestJson } from "./api";
import ProviderCard from "./ProviderCard";
import ReceivingProviderConfig from "./ReceivingProviderConfig";
import type { Domain, ReceivingProvider } from "./types";

type Option = Exclude<ReceivingProvider, "none">;
type Present = Record<Option, boolean | null>;

const OPTIONS: { id: Option; titleKey: TranslationKey; descriptionKey: TranslationKey }[] = [
	{ id: "cloudflare", titleKey: "domains.opt.cfRouting", descriptionKey: "domains.opt.cfRoutingDesc" },
	{ id: "resend", titleKey: "domains.providerResend", descriptionKey: "domains.opt.resendReceiveDesc" },
	{ id: "ses", titleKey: "domains.providerSes", descriptionKey: "domains.opt.sesReceiveDesc" },
];

type Props = {
	domain: Domain;
	onChange?: (provider: ReceivingProvider) => void;
	busy?: boolean;
	message?: string | null;
	/** Cloudflare routing status and setup, rendered by the parent that owns the DNS view. */
	cloudflareConfig: ReactNode;
	cloudflareOk: boolean;
};

export default function ReceivingSetupSection({ domain, onChange, busy, message, cloudflareConfig, cloudflareOk }: Props) {
	const { t } = useLanguage();
	const [present, setPresent] = useState<Present>({ cloudflare: null, resend: null, ses: null });
	const [ready, setReady] = useState<Record<"resend" | "ses", boolean | null>>({ resend: null, ses: null });
	const [reload, setReload] = useState(0);
	const [removing, setRemoving] = useState<Option | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		requestJson<Present>(`/api/domains/${domain.id}/receiving`, "GET")
			.then((data) => { if (active) setPresent({ cloudflare: data.cloudflare ?? null, resend: data.resend ?? null, ses: data.ses ?? null }); })
			.catch(() => { if (active) setPresent({ cloudflare: null, resend: null, ses: null }); });
		return () => { active = false; };
	}, [domain.id, domain.receivingProvider, reload]);

	async function cleanUp(option: Option, title: string) {
		if (!(await confirmAction(t("domains.removeReceivingConfirm", { title, host: domain.hostname })))) return;
		setRemoving(option);
		setError("");
		try {
			await requestJson(`/api/domains/${domain.id}/receiving`, "DELETE", { target: option });
			setReload((value) => value + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("domains.removeConfigFailed"));
		} finally { setRemoving(null); }
	}

	return (
		<section className="mt-6">
			<h2 className="text-base font-semibold text-neutral-900">{t("domains.setupReceiving")}</h2>
			<p className="mt-0.5 text-sm text-neutral-500">
				{t("domains.setupReceivingDescription")}
			</p>
			<ul className="mt-3 space-y-2">
				{OPTIONS.map((option) => {
					const selected = domain.receivingProvider === option.id;
					const ok = !selected ? null : option.id === "cloudflare" ? cloudflareOk : ready[option.id];
					return (
						<ProviderCard
							key={option.id}
							title={t(option.titleKey)}
							description={t(option.descriptionKey)}
							ok={ok}
							selected={selected}
							disabled={busy}
							onToggle={(on) => onChange?.(on ? option.id : "none")}
							cleanup={{ present: !!present[option.id], busy: removing === option.id, disabled: removing !== null, onClick: () => void cleanUp(option.id, t(option.titleKey)) }}
						>
							{option.id === "cloudflare"
								? cloudflareConfig
								: <ReceivingProviderConfig domainId={domain.id} provider={option.id} onReady={(value) => setReady((current) => current[option.id as "resend" | "ses"] === value ? current : { ...current, [option.id]: value })} />}
						</ProviderCard>
					);
				})}
			</ul>
			{domain.receivingProvider === "none" && <p className="mt-2 text-xs text-neutral-500">{t("domains.noReceiving")}</p>}
			{message && <p role="alert" className="mt-2 text-xs text-red-600">{message}</p>}
			{error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
		</section>
	);
}
