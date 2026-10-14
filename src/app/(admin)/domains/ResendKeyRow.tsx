"use client";

import { confirmAction } from "@/components/ui/installation-dialogs";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson } from "./api";
import { StatusRow } from "./status-row";

type Props = {
	configured: boolean | null;
	/** Called after the key was saved (true) or removed (false). */
	onChanged: (configured: boolean) => void;
	onError: (message: string) => void;
};

/** The shared Resend API key, used by both the sending and receiving setup. */
export default function ResendKeyRow({ configured, onChanged, onError }: Props) {
	const { t } = useLanguage();
	const [apiKey, setApiKey] = useState("");
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const showForm = configured === false || editing;

	async function run(action: () => Promise<void>) {
		setBusy(true);
		onError("");
		try { await action(); } catch (error) { onError(error instanceof Error ? error.message : t("domains.requestFailed")); } finally { setBusy(false); }
	}

	const save = () => run(async () => {
		await postJson("/api/admin/resend-key", "PUT", { apiKey });
		setApiKey("");
		setEditing(false);
		onChanged(true);
	});
	const remove = () => run(async () => {
		if (!(await confirmAction(t("resend.removeConfirm")))) return;
		await postJson("/api/admin/resend-key", "DELETE", {});
		onChanged(false);
	});

	return (
		<>
			<StatusRow
				ok={!!configured && !editing}
				title={t("resend.key")}
				hint={t("resend.keyHint")}
				action={configured && !editing ? (
					<>
						<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => setEditing(true)}>{t("resend.replace")}</Button>
						<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => void remove()}>{t("resend.remove")}</Button>
					</>
				) : undefined}
			>
				{showForm ? (
					<form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
						<Input type="password" autoComplete="off" aria-label={t("resend.key")} placeholder="re_..." value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="max-w-xs bg-white" />
						<Button type="submit" size="sm" disabled={!apiKey.trim() || busy}>{busy ? t("domains.checking") : t("resend.saveKey")}</Button>
						{editing && <Button type="button" size="sm" variant="outline" className="bg-white" onClick={() => { setEditing(false); setApiKey(""); }}>{t("common.cancel")}</Button>}
					</form>
				) : configured ? t("resend.keySaved") : t("domains.checking")}
			</StatusRow>
			{showForm && <li className="list-none px-1 text-xs text-neutral-500">{t("resend.keyInstructions")}</li>}
		</>
	);
}
