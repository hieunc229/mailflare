"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import type { SesSendingView } from "@/lib/aws/ses-sending-types";
import AwsCredentialsPanel from "./AwsCredentialsPanel";
import { requestJson } from "./api";
import { StatusRow } from "./status-row";

type SesResponse = { credentials?: boolean; ses?: SesSendingView | null; error?: string };

export default function SesSendingConfig({ domainId, onStatus }: { domainId: string; onStatus?: (status: string | null) => void }) {
	const { t } = useLanguage();
	const [credentials, setCredentials] = useState<boolean | null>(null);
	const [view, setView] = useState<SesSendingView | null>(null);
	const [loading, setLoading] = useState(true);
	const [reload, setReload] = useState(0);
	const [busy, setBusy] = useState<"setup" | "verify" | "test" | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	useEffect(() => {
		let active = true;
		requestJson<SesResponse>(`/api/domains/${domainId}/ses`, "GET")
			.then((data) => { if (active) { setCredentials(data.credentials ?? true); setView(data.ses ?? null); setError(data.error ?? ""); } })
			.catch((err) => { if (active) setError(err instanceof Error ? err.message : t("ses.unreachable")); })
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [domainId, reload, t]);

	useEffect(() => {
		if (loading) return;
		onStatus?.(credentials === false ? "no_credentials" : view ? (view.verified ? "verified" : view.registered ? "pending" : "not_registered") : null);
	}, [loading, credentials, view, onStatus]);

	const run = useCallback(async (kind: "setup" | "verify" | "test", action: () => Promise<void>) => {
		setBusy(kind);
		setError("");
		setNotice("");
		try { await action(); } catch (err) { setError(err instanceof Error ? err.message : t("domains.requestFailed")); } finally { setBusy(null); }
	}, [t]);

	const domainAction = (action: "setup" | "verify") => run(action, async () => {
		const data = await requestJson<SesResponse>(`/api/domains/${domainId}/ses`, "POST", { action });
		setView(data.ses ?? null);
	});
	const sendTest = () => run("test", async () => {
		const data = await requestJson<{ to: string }>(`/api/domains/${domainId}/ses`, "POST", { action: "test" });
		setNotice(t("resend.testSent", { to: data.to }));
	});

	const onCredentials = useCallback((configured: boolean) => {
		setCredentials(configured);
		setLoading(true);
		setReload((value) => value + 1);
	}, []);

	const label = loading ? t("ses.checking")
		: !view ? t("ses.cannotRead")
		: view.verified ? t("ses.verified")
		: !view.registered ? t("ses.notAdded")
		: view.missingDns === 0 ? t("ses.waiting", { status: view.dkimStatus.toLowerCase() })
		: view.missingDns ? t("ses.missingDkim", { count: view.missingDns })
		: t("ses.dkim", { status: view.dkimStatus.toLowerCase() });
	const buttonLabel = !view ? null
		: !view.registered ? (view.dnsManaged ? t("resend.btn.setupDomainDns") : t("resend.btn.setupDomain"))
		: view.dnsManaged && view.missingDns !== 0 ? t("resend.btn.createMissing")
		: t("resend.btn.checkStatus");

	return (
		<div className="space-y-2">
			<AwsCredentialsPanel need="sending" onChanged={onCredentials} />
			{credentials && (
				<ul className="space-y-2">
					<StatusRow
						ok={!!view?.verified}
						title={t("resend.domain")}
						hint={t("ses.domainHint")}
						action={view?.verified ? (
							<Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => void sendTest()}>{busy === "test" ? t("resend.sending") : t("resend.sendTest")}</Button>
						) : buttonLabel && !loading ? (
							<Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => void domainAction(view?.registered && (!view.dnsManaged || view.missingDns === 0) ? "verify" : "setup")}>
								{busy === "verify" ? t("domains.checking") : busy === "setup" ? t("domains.working") : buttonLabel}
							</Button>
						) : undefined}
					>
						{label}
					</StatusRow>
					{view?.productionAccess === false && (
						<StatusRow ok={false} title={t("aws.sandbox")} hint={t("ses.sandboxHint")}>
							{t("ses.sandboxDetail")}
						</StatusRow>
					)}
				</ul>
			)}
			{view && view.registered && !view.verified && !view.dnsManaged && <p className="text-xs text-neutral-500">{t("ses.addCnames")}</p>}
			{view && view.registered && !view.verified && view.dnsManaged && view.missingDns === 0 && <p className="text-xs text-neutral-500">{t("resend.propagate")}</p>}
			{view && view.registered && !view.verified && view.records.length > 0 && (
				<ul className="space-y-1 text-xs text-neutral-600">
					{view.records.map((record) => (
						<li key={record.name} className="grid gap-1 rounded-lg bg-white px-3 py-2 sm:grid-cols-[4rem_minmax(8rem,18rem)_minmax(0,1fr)]">
							<span className="font-medium">{record.type}</span>
							<span className="break-all">{record.name}</span>
							<span className="break-all">{record.value}</span>
						</li>
					))}
				</ul>
			)}
			{notice && <p role="status" className="text-xs text-green-700">{notice}</p>}
			{error && <p role="alert" className="text-xs text-red-600">{error}</p>}
		</div>
	);
}
