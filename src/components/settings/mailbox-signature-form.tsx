"use client";

import { useEffect, useState } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { isHtmlSignature, signatureToHtml } from "@/components/compose/rich-text-utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateMailboxSignature } from "./utils";

export function MailboxSignatureForm() {
	const { selectedMailbox, setSelectedMailbox, isLoading } = useSelectedMailbox();
	const [signature, setSignature] = useState("");
	const [savedSignature, setSavedSignature] = useState("");
	const [status, setStatus] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		const nextSignature = selectedMailbox?.signature ?? "";
		setSignature(nextSignature);
		setSavedSignature(nextSignature);
		setStatus(null);
	}, [selectedMailbox?.id, selectedMailbox?.signature]);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!selectedMailbox) return;
		setSaving(true);
		setStatus(null);
		try {
			const saved = await updateMailboxSignature(selectedMailbox.id, signature);
			setSignature(saved);
			setSavedSignature(saved);
			setSelectedMailbox({ ...selectedMailbox, signature: saved });
			setStatus("Saved");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Failed to update signature");
		} finally {
			setSaving(false);
		}
	}

	if (isLoading) return <p className="text-sm text-neutral-500">Loading inbox…</p>;
	if (!selectedMailbox) return <p className="text-sm text-neutral-500">Select an inbox to configure its signature.</p>;

	const address = `${selectedMailbox.localPart}@${selectedMailbox.hostname}`;
	const canManage = selectedMailbox.permission === "full_access";

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="mailboxSignature">Signature for {address}</Label>
				<Textarea
					id="mailboxSignature"
					value={signature}
					onChange={(event) => setSignature(event.target.value)}
					dir="auto"
					placeholder={"Your name\nRole or company\nContact details"}
					rows={6}
					disabled={!canManage || saving}
				/>
				<p className="text-xs leading-5 text-neutral-500">
					This signature is added when composing from the selected inbox. Plain text or HTML is supported; HTML is sanitized.
				</p>
			</div>
			{isHtmlSignature(signature) && (
				<div className="space-y-2">
					<p className="text-xs font-medium text-neutral-500">Preview</p>
					<div
						dir="auto"
						className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-900"
						dangerouslySetInnerHTML={{ __html: signatureToHtml(signature) }}
					/>
				</div>
			)}
			<div className="flex items-center gap-3">
				<Button type="submit" disabled={!canManage || saving || signature.trim() === savedSignature}>
					{saving ? "Saving..." : "Save signature"}
				</Button>
				{!canManage && <p className="text-sm text-neutral-500">Full access is required to edit this signature.</p>}
				{status && <p className="text-sm text-neutral-500">{status}</p>}
			</div>
		</form>
	);
}
