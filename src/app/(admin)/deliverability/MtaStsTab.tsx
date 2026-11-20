"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { MtaStsDialog } from "./MtaStsDialog";
import { MAX_AGE_OPTIONS, mtaStsErrorKey, mxDiffers, policyMatches, retiringDays } from "./mta-sts-utils";
import type { MtaStsBody, MtaStsOverview } from "./types";
import { fetchMtaSts, formatEventDate, postMtaStsVerified, putMtaSts } from "./utils";

type Check = "idle" | "checking" | "ok" | "mismatch" | "failed";

export function MtaStsTab({ domainId }: { domainId: string }) {
	const { t } = useLanguage();
	const [data, setData] = useState<MtaStsOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [maxAge, setMaxAge] = useState<number | null>(null);
	const [dialog, setDialog] = useState<"enforce" | "off" | null>(null);
	const [dialogError, setDialogError] = useState<string | null>(null);
	const [check, setCheck] = useState<Check>("idle");
	const [txt, setTxt] = useState<{ name: string; content: string } | null>(null);

	const describe = useCallback((cause: unknown, fallback: string) => {
		const key = mtaStsErrorKey((cause as { code?: string }).code);
		return key ? t(key) : fallback;
	}, [t]);

	const load = useCallback(async () => {
		try {
			setData(await fetchMtaSts(domainId));
		} catch (cause) {
			setError(describe(cause, t("mtasts.loadFailed")));
		}
	}, [domainId, describe, t]);

	// Deferred a tick, like the other tabs: the effect itself must not set state synchronously.
	useEffect(() => {
		const timer = setTimeout(() => void load(), 0);
		return () => clearTimeout(timer);
	}, [load]);

	async function change(body: MtaStsBody) {
		setBusy(true);
		setError(null);
		setDialogError(null);
		try {
			const { state } = await putMtaSts(domainId, body);
			setTxt(state.txt?.manual ? { name: state.txt.name, content: state.txt.content } : null);
			setDialog(null);
			setCheck("idle");
			await load();
		} catch (cause) {
			const message = describe(cause, t("mtasts.error.generic"));
			if (dialog) setDialogError(message);
			else setError(message);
		} finally {
			setBusy(false);
		}
	}

	async function verify() {
		if (!data?.policy) return;
		setCheck("checking");
		try {
			// A redirect is not a valid answer for MTA-STS, so the browser must not follow one.
			const response = await fetch(data.policyUrl, { cache: "no-store", redirect: "error" });
			if (!response.ok || !policyMatches(data.policy, await response.text())) {
				setCheck("mismatch");
				return;
			}
			await postMtaStsVerified(domainId);
			setCheck("ok");
			await load();
		} catch {
			setCheck("failed");
		}
	}

	const status = data?.status;
	const chosenAge = maxAge ?? data?.maxAge ?? 604_800;
	const ageOptions = [...new Set<number>([...MAX_AGE_OPTIONS, chosenAge])].sort((a, b) => a - b);
	const dns = data?.dns;
	return <div className="space-y-6">
		<p className="text-sm text-neutral-500">{t("mtasts.description")}</p>
		{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
		{!data && !error && <p role="status" className="text-sm text-neutral-500">{t("deliverability.loading")}</p>}
		{data && <section className="space-y-4 rounded-2xl bg-white p-5">
			<p className="text-sm font-semibold text-neutral-900">{status === "retiring" && data.retireAfter ? t("mtasts.status.retiring", { date: formatEventDate(data.retireAfter) }) : t(`mtasts.status.${status === "retiring" ? "off" : (status ?? "off")}`)}</p>
			<dl className="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
				<dt className="text-neutral-500">{t("mtasts.host")}</dt><dd className="break-all font-mono text-xs">{data.host}</dd>
				{data.policyId && <><dt className="text-neutral-500">{t("mtasts.policyId")}</dt><dd className="font-mono text-xs">{data.policyId}</dd></>}
				{data.mx.length > 0 && <><dt className="text-neutral-500">{t("mtasts.mx")}</dt><dd className="break-all font-mono text-xs">{data.mx.join(", ")}</dd></>}
				{data.policyId && <><dt className="text-neutral-500">{t("mtasts.dns.label")}</dt><dd>{dns && "error" in dns ? t("mtasts.dns.unknown") : dns?.matches ? t("mtasts.dns.matches") : t("mtasts.dns.stale")}</dd></>}
				{data.policyId && <><dt className="text-neutral-500">{t("mtasts.verify.label")}</dt><dd>{data.verifiedAt ? t("mtasts.verified", { date: formatEventDate(data.verifiedAt) }) : t("mtasts.notVerified")}</dd></>}
			</dl>
			{data.unverifiedMx.length > 0 && status !== "off" && <p role="status" className="text-sm text-amber-900">{t("mtasts.unverifiedMx", { hosts: data.unverifiedMx.join(", ") })}</p>}
			{mxDiffers(data) && data.mxDrift && "differs" in data.mxDrift && <p role="alert" className="text-sm text-red-700">{t("mtasts.mxDrift", { live: data.mxDrift.liveMx.join(", ") || "-", policy: data.mx.join(", ") })}</p>}
			{status === "retiring" && data.manualZone && data.retireAfter && <p role="status" className="break-all rounded-lg bg-neutral-100 p-3 text-xs">{t("mtasts.retiring.manual", { date: formatEventDate(data.retireAfter), name: `_${data.host}` })}</p>}
			{txt && <p role="status" className="break-all rounded-lg bg-neutral-100 p-3 text-xs">{t("mtasts.manual", { name: txt.name, value: txt.content })}</p>}
			{(status === "off" || status === "retiring" || status === "testing") && <div className="space-y-2">
				<label htmlFor="mtasts-max-age" className="block text-sm font-semibold text-neutral-900">{t("mtasts.maxAge")}</label>
				<Select id="mtasts-max-age" value={String(chosenAge)} containerClassName="w-full sm:w-48" className="h-10 text-sm" onChange={(event) => setMaxAge(Number(event.target.value))}>
					{ageOptions.map((option) => <option key={option} value={option}>{(MAX_AGE_OPTIONS as readonly number[]).includes(option) ? t(`mtasts.maxAge.${option}` as "mtasts.maxAge.86400") : `${option} s`}</option>)}
				</Select>
			</div>}
			<div className="flex flex-wrap gap-3">
				{(status === "off" || status === "retiring") && <Button type="button" size="sm" disabled={busy} onClick={() => void change({ mode: "testing", maxAge: chosenAge })}>{t("mtasts.publish")}</Button>}
				{status === "testing" && <>
					<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void change({ mode: "testing", maxAge: chosenAge })}>{t("mtasts.refresh")}</Button>
					<Button type="button" size="sm" disabled={busy} onClick={() => { setDialogError(null); setDialog("enforce"); }}>{t("mtasts.enforce")}</Button>
				</>}
				{status === "enforce" && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void change({ mode: "testing", maxAge: data.maxAge })}>{t("mtasts.backToTesting")}</Button>}
				{(status === "testing" || status === "enforce") && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setDialogError(null); setDialog("off"); }}>{t("mtasts.turnOff")}</Button>}
				{status !== "off" && <Button type="button" variant="outline" size="sm" disabled={busy || check === "checking"} onClick={() => void verify()}>{t("mtasts.verify")}</Button>}
			</div>
			{check !== "idle" && check !== "checking" && <p role="status" className={`text-sm ${check === "ok" ? "text-green-800" : "text-red-700"}`}>{t(`mtasts.verify.${check}`)}</p>}
		</section>}
		{data && <section aria-labelledby="mtasts-host-help" className="space-y-2 rounded-2xl bg-white p-5">
			<h3 id="mtasts-host-help" className="text-sm font-semibold text-neutral-900">{t("mtasts.hostHelp.title")}</h3>
			<p className="text-sm text-neutral-700">{t("mtasts.hostHelp.body", { url: data.policyUrl, host: data.host })}</p>
		</section>}
		{dialog && data && <MtaStsDialog kind={dialog} days={retiringDays(data.maxAge)} busy={busy} error={dialogError} onClose={() => setDialog(null)} onConfirm={(acknowledged) => void change(dialog === "enforce" ? { mode: "enforce", maxAge: data.maxAge, acknowledgeRisk: acknowledged } : { mode: "none" })} />}
	</div>;
}
