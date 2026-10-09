"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AwsCapabilityReport, AwsConfigStatus } from "@/lib/aws/aws-types";
import { ApiError, requestJson } from "./api";
import { StatusRow } from "./status-row";

type Props = {
	/** Which capabilities the caller needs, so only those rows are shown. */
	need: "sending" | "receiving";
	onChanged?: (configured: boolean, report: AwsCapabilityReport | null) => void;
};

type PanelResponse = { status: AwsConfigStatus; policy: unknown };

const REGION_HINTS = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-west-2", "eu-central-1", "ap-southeast-2", "ap-northeast-1", "ca-central-1"];

/** Whether an error body carries the capability report the panel renders. */
function isCapabilityReport(value: unknown): value is AwsCapabilityReport {
	return typeof value === "object" && value !== null && Array.isArray((value as AwsCapabilityReport).missing);
}

/**
 * AWS credentials shared by SES sending and receiving. Saving validates them
 * with AWS (identity, then a harmless call per service) and lists any permission
 * the key lacks, along with the IAM policy that grants everything.
 */
export default function AwsCredentialsPanel({ need, onChanged }: Props) {
	const { t } = useLanguage();
	const [status, setStatus] = useState<AwsConfigStatus | null>(null);
	const [policy, setPolicy] = useState<unknown>(null);
	const [report, setReport] = useState<AwsCapabilityReport | null>(null);
	const [editing, setEditing] = useState(false);
	const [accessKeyId, setAccessKeyId] = useState("");
	const [secretAccessKey, setSecretAccessKey] = useState("");
	const [region, setRegion] = useState("us-east-1");
	const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
	const [error, setError] = useState("");
	/** Capabilities of credentials a save refused, kept so their IAM policy can be shown next to the message. */
	const [rejected, setRejected] = useState<AwsCapabilityReport | null>(null);

	useEffect(() => {
		let active = true;
		requestJson<PanelResponse>("/api/admin/aws", "GET")
			.then(async (data) => {
				if (!active) return;
				setStatus(data.status);
				setPolicy(data.policy);
				if (data.status.region) setRegion(data.status.region);
				if (!data.status.configured) { onChanged?.(false, null); return; }
				const checked = await requestJson<{ report: AwsCapabilityReport }>("/api/admin/aws", "POST", {});
				if (active) { setReport(checked.report); onChanged?.(true, checked.report); }
			})
			.catch((err) => { if (active) { setError(err instanceof Error ? err.message : t("aws.loadFailed")); setStatus((current) => current ?? { configured: false, source: null, region: null, accessKeyHint: null, accountId: null }); } });
		return () => { active = false; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run(kind: "save" | "check" | "remove", action: () => Promise<void>) {
		setBusy(kind);
		setError("");
		try { await action(); } catch (err) { setError(err instanceof Error ? err.message : t("domains.requestFailed")); } finally { setBusy(null); }
	}

	const save = () => run("save", async () => {
		let data: { status: AwsConfigStatus; report: AwsCapabilityReport };
		try {
			data = await requestJson<{ status: AwsConfigStatus; report: AwsCapabilityReport }>("/api/admin/aws", "PUT", { accessKeyId, secretAccessKey, region });
		} catch (err) {
			// The server refuses to save credentials that lack SES permissions, and answers with the report
			// and the policy that would fix it. Keep both so the panel can show them under the message.
			const body = err instanceof ApiError ? err.data as { report?: unknown; policy?: unknown } | undefined : undefined;
			if (body && isCapabilityReport(body.report)) {
				setReport(null);
				setRejected(body.report);
				if (body.policy) setPolicy(body.policy);
			}
			throw err;
		}
		setStatus(data.status);
		setReport(data.report);
		setRejected(null);
		setEditing(false);
		setSecretAccessKey("");
		setAccessKeyId("");
		onChanged?.(true, data.report);
	});
	const check = () => run("check", async () => {
		const data = await requestJson<{ report: AwsCapabilityReport }>("/api/admin/aws", "POST", {});
		setReport(data.report);
		setRejected(null);
		onChanged?.(true, data.report);
	});
	const remove = () => run("remove", async () => {
		if (!window.confirm(t("aws.removeConfirm"))) return;
		const data = await requestJson<{ status: AwsConfigStatus }>("/api/admin/aws", "DELETE", {});
		setStatus(data.status);
		setReport(null);
		setRejected(null);
		onChanged?.(false, null);
	});

	const configured = !!status?.configured;
	const showForm = status !== null && (!configured || editing);
	const fromEnvironment = status?.source === "environment";
	// A save the server refused is not configured credentials, so its report drives the missing-permission block on its own.
	const missingReport = rejected ?? (configured && !editing ? report : null);

	return (
		<div className="space-y-2">
			<ul className="space-y-2">
				<StatusRow
					ok={configured && !editing}
					title={t("aws.credentials")}
					hint={t("aws.credentialsHint")}
					action={configured && !editing ? (
						<>
							<Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => void check()}>{busy === "check" ? t("domains.checking") : t("aws.recheck")}</Button>
							{!fromEnvironment && <Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => { setEditing(true); setError(""); setRejected(null); }}>{t("resend.replace")}</Button>}
							{!fromEnvironment && <Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => void remove()}>{t("resend.remove")}</Button>}
						</>
					) : undefined}
				>
					{showForm ? (
						<form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
							<Input autoComplete="off" placeholder={t("aws.accessKeyId")} value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} className="max-w-sm bg-white" />
							<Input type="password" autoComplete="off" placeholder={t("aws.secretKey")} value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} className="max-w-sm bg-white" />
							<Input list="aws-regions" placeholder={t("aws.region")} value={region} onChange={(event) => setRegion(event.target.value)} className="max-w-[12rem] bg-white" />
							<datalist id="aws-regions">{REGION_HINTS.map((hint) => <option key={hint} value={hint} />)}</datalist>
							<span className="flex gap-2">
								<Button type="submit" size="sm" disabled={!accessKeyId.trim() || !secretAccessKey.trim() || !region.trim() || busy !== null}>{busy === "save" ? t("aws.validating") : t("aws.validateSave")}</Button>
								{editing && <Button type="button" size="sm" variant="outline" className="bg-white" onClick={() => { setEditing(false); setError(""); setRejected(null); }}>{t("common.cancel")}</Button>}
							</span>
						</form>
					) : configured ? `${t("aws.keySummary", { hint: status?.accessKeyHint, region: status?.region })}${status?.accountId ? t("aws.accountSuffix", { id: status.accountId }) : ""}${fromEnvironment ? t("aws.envSuffix") : ""}` : t("domains.checking")}
				</StatusRow>

				{configured && !editing && report && need === "sending" && (
					<StatusRow ok={report.sending} title={t("aws.sesSending")} hint={t("aws.sesSendingHint")}>
						{report.sending ? t("aws.allowedIn", { region: report.region }) : t("aws.missingSes")}
					</StatusRow>
				)}
				{configured && !editing && report?.sending && report.productionAccess === false && need === "sending" && (
					<StatusRow ok={false} title={t("aws.sandbox")} hint={t("aws.sandboxHint")}>
						{t("aws.sandboxDetail")}
					</StatusRow>
				)}
				{configured && !editing && report && need === "receiving" && (
					<>
						<StatusRow ok={report.receivingRegion && report.receiving} title={t("aws.sesReceiving")} hint={t("aws.sesReceivingHint")}>
							{!report.receivingRegion ? t("aws.regionCannotReceive", { region: report.region }) : report.receiving ? t("aws.allowedIn", { region: report.region }) : t("aws.missingReceipt")}
						</StatusRow>
						<StatusRow ok={report.s3} title="S3" hint={t("aws.s3Hint")}>{report.s3 ? t("aws.allowed") : t("aws.missingS3")}</StatusRow>
						<StatusRow ok={report.sns} title="SNS" hint={t("aws.snsHint")}>{report.sns ? t("aws.allowed") : t("aws.missingSns")}</StatusRow>
					</>
				)}
			</ul>
			{error && <p role="alert" className="text-xs text-red-600">{error}</p>}
			{missingReport && missingReport.missing.length > 0 && (
				<details open={rejected !== null} className="rounded-lg bg-white px-3 py-2 text-xs text-neutral-600">
					<summary className="cursor-pointer font-medium text-neutral-800">{t("aws.missingSummary")}</summary>
					<p className="mt-2">{t("aws.missingList", { list: missingReport.missing.join(", ") })}</p>
					<pre className="mt-2 max-h-64 overflow-auto rounded bg-neutral-50 p-2">{JSON.stringify(policy, null, 2)}</pre>
				</details>
			)}
			{showForm && (
				<p className="text-xs text-neutral-500">
					{t("aws.createUserHint")}
				</p>
			)}
		</div>
	);
}
