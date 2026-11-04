"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import Link from "next/link";
import { Copy, KeyRound } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createJmapApiKey } from "./utils";
import { buildSignInQrPayload } from "./sign-in-qr-utils";

/** Upper bound `POST /api/api-keys` places on `mailboxIds`. */
const MAX_KEY_MAILBOXES = 30;

/**
 * Settings > App passwords card for connecting an external mail app over JMAP.
 * Mints a mailbox-scoped API key with the `jmap` scope and shows the details once.
 * `POST /api/api-keys` requires `mailboxIds` for mail scopes, and a JMAP session
 * only lists the mailboxes a key was granted, so the card asks which to include.
 */
export function EmailClientsSettings() {
	const { t } = useLanguage();
	const { mailboxes, selectedMailbox, isLoading } = useSelectedMailbox();
	const [name, setName] = useState("");
	// `null` until the user changes the selection, which means every accessible mailbox —
	// the same set a key could see before keys were mailbox-scoped. The API accepts at
	// most 30 mailboxes per key, so past that the default is just the current mailbox.
	const [chosenMailboxIds, setChosenMailboxIds] = useState<string[] | null>(null);
	const mailboxIds = chosenMailboxIds ?? (mailboxes.length <= MAX_KEY_MAILBOXES ? mailboxes.map((mailbox) => mailbox.id) : [selectedMailbox?.id ?? mailboxes[0]?.id].filter((id): id is string => !!id));
	const [key, setKey] = useState<string | null>(null);
	const [username, setUsername] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const [qr, setQr] = useState<string | null>(null);
	const server = typeof window !== "undefined" ? window.location.origin : "";

	// The mobile app scans this to fill in the sign-in form; it carries the key, so it is
	// rendered in the browser and never leaves the page.
	useEffect(() => {
		if (!key) {
			setQr(null);
			return;
		}
		let cancelled = false;
		QRCode.toDataURL(buildSignInQrPayload({ server, email: username, key }), { margin: 1, width: 240, errorCorrectionLevel: "M" })
			.then((url) => { if (!cancelled) setQr(url); })
			.catch(() => { if (!cancelled) setQr(null); });
		return () => { cancelled = true; };
	}, [key, server, username]);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const created = await createJmapApiKey(name.trim() || t("emailClients.defaultName"), mailboxIds);
			// The server ignores the username, but mail apps want an email address there.
			const first = mailboxes.find((mailbox) => mailbox.id === mailboxIds[0]);
			setUsername(first ? `${first.localPart}@${first.hostname}` : "");
			setKey(created);
			setName("");
		} catch (err) {
			setError(err instanceof Error ? err.message : t("emailClients.createFailed"));
		} finally {
			setBusy(false);
		}
	}

	function copy(label: string, value: string) {
		void navigator.clipboard.writeText(value).then(() => setCopied(label));
	}

	return (
		<div className="space-y-4">
			<p className="text-sm text-neutral-500">
				{t("emailClients.description")}
			</p>
			{key ? (
				<div className="space-y-3 rounded-2xl bg-neutral-50 p-4">
					<Field label={t("emailClients.server")} value={server} onCopy={copy} copied={copied} />
					<Field label={t("emailClients.username")} value={username || t("emailClients.anyValue")} onCopy={copy} copied={copied} />
					<Field label={t("emailClients.passwordApiKey")} value={key} onCopy={copy} copied={copied} mono />
					{qr && (
						<div className="flex flex-col items-center gap-2 rounded-xl bg-white p-4">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src={qr} alt={t("emailClients.qrAlt")} width={240} height={240} />
							<p className="text-center text-xs text-neutral-500">{t("emailClients.qrHint")}</p>
						</div>
					)}
					<p className="text-xs text-neutral-500">
						{t("emailClients.shownOnce", { link: "\u0001", url: "\u0002" }).split(/(\u0001|\u0002)/).map((part, index) => part === "\u0001" ? <Link key={index} href="/settings/api-keys" className="text-blue-700 underline">{t("settings.nav.apiKeys")}</Link> : part === "\u0002" ? <code key={index}>{server}/.well-known/jmap</code> : part)}
					</p>
				</div>
			) : (
				<form onSubmit={submit} className="space-y-4">
					<div className="flex flex-wrap items-end gap-3">
						<div className="min-w-56 flex-1 space-y-2">
							<Label htmlFor="jmap-key-name">{t("emailClients.deviceName")}</Label>
							<Input id="jmap-key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("emailClients.devicePlaceholder")} />
						</div>
						<Button type="submit" disabled={busy || isLoading || !mailboxIds.length || mailboxIds.length > MAX_KEY_MAILBOXES}>
							<KeyRound className="h-4 w-4" />
							{busy ? t("emailClients.creating") : t("emailClients.create")}
						</Button>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">{t("emailClients.mailboxesLegend")}</legend>
						{isLoading ? (
							<p className="text-sm text-neutral-500">{t("emailClients.loadingMailboxes")}</p>
						) : mailboxes.length === 0 ? (
							<p className="text-sm text-neutral-500">{t("apiKeys.noMailboxes")}</p>
						) : (
							mailboxes.map((mailbox) => (
								<label key={mailbox.id} className="flex items-center gap-3 text-sm">
									<Checkbox
										checked={mailboxIds.includes(mailbox.id)}
										onChange={(event) => setChosenMailboxIds(event.target.checked ? [...mailboxIds, mailbox.id] : mailboxIds.filter((id) => id !== mailbox.id))}
									/>
									{mailbox.localPart}@{mailbox.hostname}
								</label>
							))
						)}
						<p className="text-xs text-neutral-500">{t("emailClients.aliasLimit", { max: MAX_KEY_MAILBOXES })}</p>
					</fieldset>
					{error && <p role="alert" className="w-full text-sm text-red-600">{error}</p>}
				</form>
			)}
		</div>
	);
}

function Field({ label, value, onCopy, copied, mono }: { label: string; value: string; onCopy: (label: string, value: string) => void; copied: string | null; mono?: boolean }) {
	const { t } = useLanguage();
	return (
		<div className="flex items-center gap-3">
			<span className="w-36 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</span>
			<code className={`min-w-0 flex-1 truncate rounded-md bg-white px-2 py-1 text-sm ${mono ? "font-mono" : "font-sans"}`}>{value}</code>
			<Button type="button" variant="ghost" size="sm" onClick={() => onCopy(label, value)} aria-label={t("common.copyLabel", { label })}>
				<Copy className="h-4 w-4" />
				{copied === label ? t("common.copied") : t("common.copy")}
			</Button>
		</div>
	);
}
