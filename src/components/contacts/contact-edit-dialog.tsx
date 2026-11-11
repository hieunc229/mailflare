"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseAddress } from "@/lib/utils";
import { ContactAvatarForm } from "./contact-avatar-form";
import type { ContactEditDialogProps, ContactListItem } from "./contacts-page-types";
import { createContact, renameContact } from "./contacts-page-utils";

/** Create or rename a contact. Editing also allows changing the photo; creating collects email and name. */
export function ContactEditDialog({
	mailboxId,
	contact,
	open,
	onOpenChange,
	onSaved,
}: ContactEditDialogProps) {
	const { t } = useLanguage();
	const editing = contact !== null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{editing ? t("contacts.edit") : t("contacts.new")}</DialogTitle>
					<DialogDescription>{t("contacts.dialogDescription")}</DialogDescription>
				</DialogHeader>
				{/* Lives inside DialogContent so it unmounts with the dialog and every open starts clean. */}
				<ContactEditForm
					mailboxId={mailboxId}
					contact={contact}
					onOpenChange={onOpenChange}
					onSaved={onSaved}
				/>
			</DialogContent>
		</Dialog>
	);
}

function ContactEditForm({
	mailboxId,
	contact,
	onOpenChange,
	onSaved,
}: {
	mailboxId: string;
	contact: ContactListItem | null;
	onOpenChange: ContactEditDialogProps["onOpenChange"];
	onSaved: ContactEditDialogProps["onSaved"];
}) {
	const { t } = useLanguage();
	const editing = contact !== null;
	const [email, setEmail] = useState(contact?.email ?? "");
	const [displayName, setDisplayName] = useState(contact?.displayName ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = displayName.trim();
		if (editing) {
			if (!name) return;
		} else if (!parseAddress(email)) {
			setError(t("contacts.invalidEmail"));
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const saved = editing
				? await renameContact(mailboxId, contact.email, name)
				: await createContact(mailboxId, { address: email.trim(), displayName: name || undefined });
			onSaved(saved);
			onOpenChange(false);
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : t("contacts.saveFailed"));
		} finally {
			setSaving(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			{editing && (
				<ContactAvatarForm
					mailboxId={mailboxId}
					address={contact.email}
					name={displayName}
					hasAvatar={contact.hasAvatar}
					onAvatarChange={(hasAvatar) => onSaved({ ...contact, hasAvatar })}
				/>
			)}
			<div className="space-y-2">
				<Label htmlFor="contact-edit-name">{t("contact.name")}</Label>
				<Input
					id="contact-edit-name"
					value={displayName}
					onChange={(event) => setDisplayName(event.target.value)}
					disabled={saving}
					autoFocus={editing}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="contact-edit-email">{t("contact.email")}</Label>
				<Input
					id="contact-edit-email"
					type="email"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder={t("contacts.emailPlaceholder")}
					disabled={saving || editing}
					autoFocus={!editing}
					required={!editing}
				/>
			</div>
			{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
			<div className="flex justify-end gap-2 border-t border-neutral-200 pt-4">
				<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
					{t("common.cancel")}
				</Button>
				<Button
					type="submit"
					disabled={saving || (editing ? !displayName.trim() : !email.trim())}
				>
					{saving ? t("common.saving") : t("common.save")}
				</Button>
			</div>
		</form>
	);
}
