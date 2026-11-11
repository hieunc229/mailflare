"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { ContactDeleteDialogProps, ContactListItem } from "./contacts-page-types";
import { deleteContact } from "./contacts-page-utils";

export function ContactDeleteDialog({
	mailboxId,
	contact,
	onOpenChange,
	onDeleted,
}: ContactDeleteDialogProps) {
	const { t } = useLanguage();

	return (
		<Dialog open={contact !== null} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("contacts.deleteTitle")}</DialogTitle>
					<DialogDescription>
						{t("contacts.deleteDescription", { name: contact?.displayName ?? contact?.email ?? "" })}
					</DialogDescription>
				</DialogHeader>
				{contact && (
					<DeleteConfirm
						mailboxId={mailboxId}
						contact={contact}
						onDeleted={onDeleted}
						onOpenChange={onOpenChange}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Lives inside DialogContent so it unmounts with the dialog and every open starts clean. */
function DeleteConfirm({
	mailboxId,
	contact,
	onDeleted,
	onOpenChange,
}: {
	mailboxId: string;
	contact: ContactListItem;
	onDeleted: ContactDeleteDialogProps["onDeleted"];
	onOpenChange: ContactDeleteDialogProps["onOpenChange"];
}) {
	const { t } = useLanguage();
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function confirm() {
		setDeleting(true);
		setError(null);
		try {
			await deleteContact(mailboxId, contact.email);
			onDeleted(contact);
			onOpenChange(false);
		} catch (deleteError) {
			setError(deleteError instanceof Error ? deleteError.message : t("contacts.deleteFailed"));
		} finally {
			setDeleting(false);
		}
	}

	return (
		<>
			{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
			<div className="flex justify-end gap-2 border-t border-neutral-200 pt-4">
				<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
					{t("common.cancel")}
				</Button>
				<Button type="button" variant="destructive" onClick={confirm} disabled={deleting}>
					{deleting ? t("contacts.deleting") : t("common.delete")}
				</Button>
			</div>
		</>
	);
}
