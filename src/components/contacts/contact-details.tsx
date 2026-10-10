"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { formatUserDate } from "@/lib/time/utils";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ContactAvatarForm } from "./contact-avatar-form";
import { Label } from "@/components/ui/label";
import type { ContactDetailsRecord, ContactDetailsTriggerProps } from "./contact-details-types";
import {
	fetchContactDetails,
	updateContactName,
} from "./contact-details-utils";

export function ContactDetailsTrigger({
	mailboxId,
	address,
	name,
	label,
	className,
}: ContactDetailsTriggerProps) {
	const { t } = useLanguage();
	const [open, setOpen] = useState(false);
	const visibleLabel = label ?? name;
	const [renamed, setRenamed] = useState<{ from: string; value: string } | null>(null);
	const shownName = renamed?.from === visibleLabel ? renamed.value : visibleLabel;
	const [contact, setContact] = useState<ContactDetailsRecord | null>(null);
	const [displayName, setDisplayName] = useState(name);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function handleOpenChange(next: boolean) {
		if (next) {
			setLoading(true);
			setError(null);
		}
		setOpen(next);
	}

	useEffect(() => {
		if (!open || !mailboxId) return;
		let cancelled = false;
		fetchContactDetails(mailboxId, address)
			.then((nextContact) => {
				if (cancelled) return;
				setContact(nextContact);
				setDisplayName(nextContact.displayName ?? name);
			})
			.catch((loadError) => {
				if (!cancelled) setError(loadError instanceof Error ? loadError.message : t("contact.loadFailed"));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [address, mailboxId, name, open]);

	async function saveContact() {
		if (!mailboxId || !displayName.trim()) return;
		setSaving(true);
		setError(null);
		try {
			const updated = await updateContactName(mailboxId, address, displayName);
			const nextName = updated.displayName ?? displayName.trim();
			setContact(updated);
			if (!label) setRenamed({ from: visibleLabel, value: nextName });
			setOpen(false);
			window.dispatchEvent(new CustomEvent("mailflare:contact-changed", {
				detail: { email: updated.email, displayName: nextName },
			}));
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : t("contact.updateFailed"));
		} finally {
			setSaving(false);
		}
	}

	if (!mailboxId) return <span className={className}>{shownName}</span>;

	return (
		<>
			<button
				type="button"
				onClick={() => handleOpenChange(true)}
				className={`${className ?? ""} rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200`}
			>
				{shownName}
			</button>
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("contact.title")}</DialogTitle>
						<DialogDescription>{t("contact.description")}</DialogDescription>
					</DialogHeader>
					<div className="space-y-5">
						<div className="flex flex-col items-start gap-4">
							<ContactAvatarForm
								mailboxId={mailboxId}
								address={address}
								name={displayName}
								hasAvatar={contact?.hasAvatar ?? false}
								onAvatarChange={(hasAvatar) => setContact((current) => current ? { ...current, hasAvatar } : current)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="contact-display-name">{t("contact.name")}</Label>
							<Input
								id="contact-display-name"
								value={displayName}
								onChange={(event) => setDisplayName(event.target.value)}
								disabled={loading || saving}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="contact-email">{t("contact.email")}</Label>
							<Input
								id="contact-email"
								value={contact?.email ?? address}
								disabled
							/>
						</div>
						<div className="grid gap-3 rounded-lg bg-neutral-50 p-3 text-sm sm:grid-cols-2">
							<div>
								<p className="text-xs font-medium uppercase text-neutral-500">{t("contact.source")}</p>
								<p className="mt-1 capitalize text-neutral-700">{contact?.source ?? t("contact.sourceEmail")}</p>
							</div>
							<div>
								<p className="text-xs font-medium uppercase text-neutral-500">{t("contact.lastSeen")}</p>
								<p className="mt-1 text-neutral-700">
									{contact?.lastSeenAt ? formatUserDate(contact.lastSeenAt, { month: "short", day: "2-digit", year: "numeric" }) : t("contact.unknown")}
								</p>
							</div>
							{contact?.blocked && (
								<p className="text-sm font-medium text-red-600">{t("contact.blocked")}</p>
							)}
						</div>
						{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
						<Button
							type="button"
							onClick={saveContact}
							disabled={loading || saving || !displayName.trim()}
						>
							{saving ? t("contact.saving") : t("contact.save")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
