"use client";

import { useEffect, useState } from "react";
import { Upload } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
	disconnectOutlook,
	ensureImportDestination,
	fetchOutlookFolders,
	fetchOutlookSession,
	filterCustomImapFolders,
	getFolderImportSource,
	resolveImapSourceFolder,
	startOutlookImport,
	startOutlookSignIn,
} from "@/app/(settings)/settings/import/utils";
import type { ImportSourceItem, OutlookSession } from "@/app/(settings)/settings/import/types";

export function OutlookImport({
	mailboxId,
	selectedSources,
	notice,
	onStarted,
}: {
	mailboxId: string | undefined;
	selectedSources: ImportSourceItem[];
	notice: string | null;
	onStarted: () => void;
}) {
	const { t } = useLanguage();
	const [session, setSession] = useState<OutlookSession | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(notice);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [tenant, setTenant] = useState("common");
	const [tenantId, setTenantId] = useState("");
	const [limit, setLimit] = useState("100");
	const [importAll, setImportAll] = useState(true);
	const [busy, setBusy] = useState(false);
	const [started, setStarted] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetchOutlookSession()
			.then((next) => {
				if (!cancelled) setSession(next);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "Outlook import failed");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function reload() {
		setSession(await fetchOutlookSession());
	}

	async function connect() {
		setBusy(true);
		setError(null);
		try {
			await startOutlookSignIn(session?.configured ? {} : { clientId, clientSecret, tenant: tenantId.trim() || tenant });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("importPage.outlookFailed"));
			setBusy(false);
		}
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		try {
			await disconnectOutlook();
			await reload();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("importPage.outlookFailed"));
		} finally {
			setBusy(false);
		}
	}

	async function submit() {
		if (!mailboxId || selectedSources.length === 0) return;
		setBusy(true);
		setError(null);
		setStarted(false);
		try {
			const discovered = await fetchOutlookFolders();
			const expanded: ImportSourceItem[] = [];
			for (const source of selectedSources) {
				if (source.id === "system:others") {
					expanded.push(...filterCustomImapFolders(discovered, selectedSources).map(getFolderImportSource));
				} else {
					expanded.push(source);
				}
			}
			const sources: { folder: string; destination: string }[] = [];
			for (const source of expanded) {
				sources.push({
					folder: resolveImapSourceFolder(source, discovered),
					destination: source.folderName ? await ensureImportDestination(mailboxId, source) : source.destination,
				});
			}
			await startOutlookImport(mailboxId, { limit: Number(limit), importAll }, sources);
			setStarted(true);
			onStarted();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("importPage.outlookFailed"));
		} finally {
			setBusy(false);
		}
	}

	async function copyRedirect() {
		if (!session?.redirectUri) return;
		try {
			await navigator.clipboard.writeText(session.redirectUri);
		} catch {
			setError(session.redirectUri);
		}
	}

	if (loadError) {
		return <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>;
	}
	if (!session) return <p className="text-sm text-neutral-500">{t("importPage.discovering")}</p>;

	return (
		<div className="space-y-4">
			<p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">
				{t("importPage.outlookNote")}
			</p>
			{session.configError && (
				<p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{session.configError}</p>
			)}
			<div className="space-y-2">
				<Label htmlFor="outlook-redirect">{t("importPage.outlookRedirect")}</Label>
				<div className="flex gap-2">
					<Input id="outlook-redirect" readOnly value={session.redirectUri} />
					<Button type="button" variant="outline" onClick={() => void copyRedirect()}>
						{t("importPage.outlookCopy")}
					</Button>
				</div>
			</div>
			{!session.configured && !session.configError && (
				<>
					<ol className="list-decimal space-y-1 pl-5 text-xs leading-5 text-neutral-500">
						<li>{t("importPage.outlookStep1")}</li>
						<li>{t("importPage.outlookStep2")}</li>
						<li>{t("importPage.outlookStep3")}</li>
					</ol>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="outlook-client">{t("importPage.outlookClientId")}</Label>
							<Input id="outlook-client" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" placeholder="00000000-0000-0000-0000-000000000000" />
						</div>
						<div className="space-y-2">
							<Label htmlFor="outlook-secret">{t("importPage.outlookClientSecret")}</Label>
							<Input id="outlook-secret" type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" />
							<p className="text-xs text-neutral-500">{t("importPage.outlookClientSecretHint")}</p>
						</div>
					</div>
					<div className="space-y-2">
						<Label htmlFor="outlook-tenant">{t("importPage.outlookTenant")}</Label>
						<Select id="outlook-tenant" value={tenant} onChange={(event) => setTenant(event.target.value)} disabled={tenantId.trim().length > 0}>
							<option value="common">{t("importPage.outlookTenantCommon")}</option>
							<option value="organizations">{t("importPage.outlookTenantOrganizations")}</option>
							<option value="consumers">{t("importPage.outlookTenantConsumers")}</option>
						</Select>
					</div>
					<div className="space-y-2">
						<Label htmlFor="outlook-tenant-id">{t("importPage.outlookTenantId")}</Label>
						<Input id="outlook-tenant-id" value={tenantId} onChange={(event) => setTenantId(event.target.value)} autoComplete="off" placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} />
						<p className="text-xs text-neutral-500">{t("importPage.outlookTenantIdHint")}</p>
					</div>
				</>
			)}
			{session.connected && session.username ? (
				<p className="text-sm text-neutral-700">{t("importPage.outlookConnected", { email: session.username })}</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button type="button" variant={session.connected ? "outline" : "default"} disabled={busy || !!session.configError || (!session.configured && !clientId.trim())} onClick={() => void connect()}>
					{busy && !session.connected ? t("importPage.outlookConnecting") : t("importPage.outlookConnect")}
				</Button>
				{session.connected && (
					<Button type="button" variant="outline" disabled={busy} onClick={() => void disconnect()}>
						{t("importPage.outlookDisconnect")}
					</Button>
				)}
			</div>
			{session.connected && (
				<>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="outlook-limit">{importAll ? t("importPage.perBatch") : t("importPage.perSource")}</Label>
							<Input id="outlook-limit" type="number" min={1} max={100} value={limit} onChange={(event) => setLimit(event.target.value)} />
						</div>
						<label className="flex items-end gap-2 pb-2 text-sm text-neutral-700">
							<Checkbox checked={importAll} onChange={(event) => setImportAll(event.target.checked)} />
							{t("importPage.importAll")}
						</label>
					</div>
					<Button type="button" disabled={!mailboxId || selectedSources.length === 0 || busy} onClick={() => void submit()}>
						<Upload className="h-4 w-4" />
						{busy ? t("import.importing") : t("importPage.importSources")}
					</Button>
				</>
			)}
			{started && <p className="rounded-lg border border-green-100 bg-green-50 px-4 py-3 text-sm text-green-700">{t("importJobs.started")}</p>}
			{error && <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
		</div>
	);
}
