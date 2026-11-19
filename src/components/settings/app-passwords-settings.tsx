"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, KeyRound } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClientRequestError } from "@/lib/http/client-error";
import { formatUserDate } from "@/lib/time/utils";
import type { AppPasswordList, AppPasswordSummary, CreatedAppPassword } from "./app-passwords-types";
import { appPasswordProtocolName, createAppPassword, groupAppPassword, loadAppPasswords, revokeAppPassword } from "./app-passwords-utils";
import { buildSignInQrPayload } from "./sign-in-qr-utils";
import { useSecurityStatus } from "./security-status-store";
import { StepUpDialog } from "./step-up-dialog";

/** Upper bound `POST /api/app-passwords` places on `mailboxIds`. */
const MAX_KEY_MAILBOXES = 30;

/** Protocols that read mail are limited to the mailboxes picked below; `dav` is user-level. */
const needsMailboxes = (protocols: string[]) => protocols.some((protocol) => protocol !== "dav");

type Created = CreatedAppPassword & { username: string };

/**
 * Settings > App passwords: create (after confirming identity), list and revoke
 * the passwords that let a mail app sign in without the account password. The
 * password is shown once, right after creation.
 */
export function AppPasswordsSettings() {
	const { t } = useLanguage();
	const { mailboxes, selectedMailbox, isLoading } = useSelectedMailbox();
	const { status } = useSecurityStatus();
	const [list, setList] = useState<AppPasswordList | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [name, setName] = useState("");
	// `null` until the user changes the selection, which means every protocol this server offers.
	const [chosenProtocols, setChosenProtocols] = useState<string[] | null>(null);
	// `null` until the user changes the selection, which means every accessible mailbox. The API
	// accepts at most 30 per key, so past that the default is just the current mailbox.
	const [chosenMailboxIds, setChosenMailboxIds] = useState<string[] | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [created, setCreated] = useState<Created | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [qr, setQr] = useState<string | null>(null);
	const server = typeof window !== "undefined" ? window.location.origin : "";

	const protocols = chosenProtocols ?? list?.availableProtocols ?? [];
	const mailboxIds = chosenMailboxIds ?? (mailboxes.length <= MAX_KEY_MAILBOXES ? mailboxes.map((mailbox) => mailbox.id) : [selectedMailbox?.id ?? mailboxes[0]?.id].filter((id): id is string => !!id));
	const mailboxScoped = needsMailboxes(protocols);
	const canSubmit = !!list && !isLoading && protocols.length > 0 && (!mailboxScoped || (mailboxIds.length > 0 && mailboxIds.length <= MAX_KEY_MAILBOXES));

	const refresh = useCallback(() => {
		loadAppPasswords().then((next) => { setList(next); setLoadFailed(false); }).catch(() => setLoadFailed(true));
	}, []);
	useEffect(refresh, [refresh]);

	// The mobile app scans this to fill in its sign-in form; it carries the password, so it is
	// rendered in the browser and never leaves the page. Only JMAP is what the app speaks.
	const createdKey = created?.protocols.includes("jmap") ? created.key : null;
	const createdUsername = created?.username ?? "";
	useEffect(() => {
		if (!createdKey) return;
		let cancelled = false;
		QRCode.toDataURL(buildSignInQrPayload({ server, email: createdUsername, key: createdKey }), { margin: 1, width: 240, errorCorrectionLevel: "M" })
			.then((url) => { if (!cancelled) setQr(url); })
			.catch(() => { if (!cancelled) setQr(null); });
		return () => { cancelled = true; };
	}, [createdKey, server, createdUsername]);

	async function authorized(stepUpToken: string) {
		try {
			const made = await createAppPassword({ name: name.trim() || t("emailClients.defaultName"), protocols, mailboxIds: mailboxScoped ? mailboxIds : [] }, stepUpToken);
			// The server ignores the username, but mail apps want an email address there.
			const first = mailboxes.find((mailbox) => mailbox.id === made.mailboxIds[0]);
			setCreated({ ...made, username: first ? `${first.localPart}@${first.hostname}` : "" });
			setName("");
			setError(null);
			refresh();
		} catch (err) {
			// A refused confirmation is the dialog's to explain; anything else belongs on the form.
			if (err instanceof ClientRequestError && err.code) throw err;
			setError(err instanceof Error ? err.message : t("emailClients.createFailed"));
		}
	}

	async function revoke(item: AppPasswordSummary) {
		if (!await confirmDestructive(t("apiKeys.revokeConfirm", { name: item.name }))) return;
		try {
			await revokeAppPassword(item.id);
			setList((current) => current && { ...current, appPasswords: current.appPasswords.filter((entry) => entry.id !== item.id) });
		} catch (err) {
			setError(err instanceof Error ? err.message : t("apiKeys.revokeFailed"));
		}
	}

	function copy(label: string, value: string) {
		void navigator.clipboard.writeText(value).then(() => setCopied(label));
	}

	function toggle<T>(current: T[], value: T, on: boolean) {
		return on ? [...current, value] : current.filter((item) => item !== value);
	}

	function lastUsed(item: AppPasswordSummary) {
		if (!item.lastUsedAt) return t("apiKeys.neverUsed");
		const date = formatUserDate(item.lastUsedAt, { dateStyle: "short" });
		return item.lastUsedProtocol
			? t("appPasswords.lastUsedVia", { date, protocol: appPasswordProtocolName(item.lastUsedProtocol), ip: item.lastUsedIp ?? t("appPasswords.unknownIp") })
			: t("apiKeys.lastUsed", { date });
	}

	function protocolLabel(protocol: string) {
		return t(`appPasswords.protocol.${protocol}` as "appPasswords.protocol.jmap");
	}

	return (
		<div className="space-y-6">
			<p className="text-sm text-neutral-500">{t("appPasswords.description")}</p>
			{created ? (
				<div className="space-y-3 rounded-2xl bg-neutral-50 p-4">
					<h2 className="text-sm font-semibold text-neutral-900">{t("appPasswords.createdTitle")}</h2>
					<Field label={t("emailClients.server")} value={server} onCopy={copy} copied={copied} />
					<Field label={t("emailClients.username")} value={created.username || t("emailClients.anyValue")} onCopy={copy} copied={copied} />
					<Field label={t("emailClients.passwordApiKey")} value={groupAppPassword(created.key)} copyValue={created.key} onCopy={copy} copied={copied} mono />
					{qr && createdKey && (
						<div className="flex flex-col items-center gap-2 rounded-xl bg-white p-4">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src={qr} alt={t("emailClients.qrAlt")} width={240} height={240} />
							<p className="text-center text-xs text-neutral-500">{t("emailClients.qrHint")}</p>
						</div>
					)}
					<p className="text-xs text-neutral-500">{t("appPasswords.shownOnce")}</p>
					{created.protocols.includes("jmap") && <p className="text-xs text-neutral-500">{t("appPasswords.jmapDiscovery", { url: `${server}/.well-known/jmap` })}</p>}
					<Button type="button" variant="outline" onClick={() => { setCreated(null); setQr(null); }}>{t("common.done")}</Button>
				</div>
			) : (
				<form onSubmit={(event) => { event.preventDefault(); setConfirming(true); }} className="space-y-4">
					<div className="flex flex-wrap items-end gap-3">
						<div className="min-w-56 flex-1 space-y-2">
							<Label htmlFor="app-password-name">{t("emailClients.deviceName")}</Label>
							<Input id="app-password-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={t("emailClients.devicePlaceholder")} />
						</div>
						<Button type="submit" disabled={!canSubmit}>
							<KeyRound className="h-4 w-4" />
							{t("emailClients.create")}
						</Button>
					</div>
					{list && (
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">{t("appPasswords.protocolsLegend")}</legend>
							{list.availableProtocols.map((protocol) => (
								<label key={protocol} className="flex items-center gap-3 text-sm">
									<Checkbox checked={protocols.includes(protocol)} onChange={(event) => setChosenProtocols(toggle(protocols, protocol, event.target.checked))} />
									{protocolLabel(protocol)}
								</label>
							))}
							{protocols.length === 0 && <p role="alert" className="text-sm text-red-600">{t("appPasswords.chooseProtocol")}</p>}
						</fieldset>
					)}
					{mailboxScoped && (
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">{t("emailClients.mailboxesLegend")}</legend>
							{isLoading ? (
								<p className="text-sm text-neutral-500">{t("emailClients.loadingMailboxes")}</p>
							) : mailboxes.length === 0 ? (
								<p className="text-sm text-neutral-500">{t("apiKeys.noMailboxes")}</p>
							) : (
								mailboxes.map((mailbox) => (
									<label key={mailbox.id} className="flex items-center gap-3 text-sm">
										<Checkbox checked={mailboxIds.includes(mailbox.id)} onChange={(event) => setChosenMailboxIds(toggle(mailboxIds, mailbox.id, event.target.checked))} />
										{mailbox.localPart}@{mailbox.hostname}
									</label>
								))
							)}
							<p className="text-xs text-neutral-500">{t("emailClients.aliasLimit", { max: MAX_KEY_MAILBOXES })}</p>
						</fieldset>
					)}
				</form>
			)}
			{error && <p role="alert" className="text-sm text-red-600">{error}</p>}

			<section aria-labelledby="app-passwords-list-title" className="space-y-3">
				<h2 id="app-passwords-list-title" className="text-sm font-semibold text-neutral-900">{t("appPasswords.listTitle")}</h2>
				{loadFailed ? (
					<p role="alert" className="text-sm text-red-600">{t("appPasswords.loadFailed")}</p>
				) : !list ? (
					<p className="text-sm text-neutral-500">{t("common.loading")}</p>
				) : list.appPasswords.length === 0 ? (
					<p className="text-sm text-neutral-500">{t("appPasswords.empty")}</p>
				) : (
					<ul className="divide-y divide-neutral-100 rounded-2xl bg-neutral-50">
						{list.appPasswords.map((item) => (
							<li key={item.id} className="flex items-center gap-3 p-4">
								<KeyRound className="h-5 w-5 shrink-0 text-neutral-500" aria-hidden="true" />
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium text-neutral-900">{item.name}</p>
									<p className="text-sm text-neutral-500">
										{item.legacy ? t("appPasswords.legacyJmap") : item.protocols.map(protocolLabel).join(", ")}
									</p>
									<p className="text-sm text-neutral-500">
										{t("apiKeys.createdOn", { date: formatUserDate(item.createdAt, { dateStyle: "short" }) })} · {lastUsed(item)}
									</p>
								</div>
								<Button variant="outline" size="sm" onClick={() => void revoke(item)} aria-label={`${t("common.revoke")}: ${item.name}`}>
									{t("common.revoke")}
								</Button>
							</li>
						))}
					</ul>
				)}
			</section>

			<StepUpDialog
				open={confirming}
				hasPassword={status?.passwordSet ?? false}
				hasPasskey={(status?.passkeys.length ?? 0) > 0}
				requireSecondFactor={status?.requireSecondFactor ?? false}
				totpEnabled={status?.totpEnabled ?? false}
				action="app_password.create"
				title={t("appPasswords.stepUpTitle")}
				description={t("appPasswords.stepUpDescription")}
				onOpenChange={setConfirming}
				onAuthorized={authorized}
			/>
		</div>
	);
}

function Field({ label, value, copyValue, onCopy, copied, mono }: { label: string; value: string; copyValue?: string; onCopy: (label: string, value: string) => void; copied: string | null; mono?: boolean }) {
	const { t } = useLanguage();
	return (
		<div className="flex items-center gap-3">
			<span className="w-36 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</span>
			<code className={`min-w-0 flex-1 truncate rounded-md bg-white px-2 py-1 text-sm ${mono ? "font-mono" : "font-sans"}`}>{value}</code>
			<Button type="button" variant="ghost" size="sm" onClick={() => onCopy(label, copyValue ?? value)} aria-label={t("common.copyLabel", { label })}>
				<Copy className="h-4 w-4" />
				{copied === label ? t("common.copied") : t("common.copy")}
			</Button>
		</div>
	);
}
