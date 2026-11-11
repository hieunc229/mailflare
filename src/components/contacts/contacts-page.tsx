"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, UsersRound } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useCompose } from "@/components/compose/compose-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { formatEmailAddress } from "@/lib/email/address";
import { ContactDeleteDialog } from "./contact-delete-dialog";
import { ContactEditDialog } from "./contact-edit-dialog";
import { ContactRow } from "./contact-row";
import type { ContactListItem } from "./contacts-page-types";
import { fetchContacts } from "./contacts-page-utils";

const SEARCH_DEBOUNCE_MS = 250;

export function ContactsPage() {
	const { t } = useLanguage();
	const queryClient = useQueryClient();
	const { selectedMailbox } = useSelectedMailbox();
	const { openComposer } = useCompose();
	const mailboxId = selectedMailbox?.id ?? "";
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");
	const [editOpen, setEditOpen] = useState(false);
	const [editing, setEditing] = useState<ContactListItem | null>(null);
	const [deleting, setDeleting] = useState<ContactListItem | null>(null);

	useEffect(() => {
		const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [input]);

	const contacts = useQuery({
		queryKey: ["contacts", mailboxId, query],
		enabled: !!mailboxId,
		queryFn: () => fetchContacts(mailboxId, query),
	});

	function refresh() {
		void queryClient.invalidateQueries({ queryKey: ["contacts", mailboxId] });
	}

	function openCreate() {
		setEditing(null);
		setEditOpen(true);
	}

	const items = contacts.data ?? [];

	return (
		<div className="mx-auto w-full max-w-3xl px-6 py-8">
			<header className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-normal text-neutral-900">{t("contacts.title")}</h1>
					<p className="mt-1 text-sm text-neutral-500">{t("contacts.description")}</p>
				</div>
				<Button type="button" onClick={openCreate} disabled={!mailboxId}>
					<Plus className="h-4 w-4" />
					{t("contacts.add")}
				</Button>
			</header>

			<div className="relative mt-6">
				<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
				<Input
					type="search"
					value={input}
					onChange={(event) => setInput(event.target.value)}
					placeholder={t("contacts.search")}
					aria-label={t("contacts.search")}
					className="pl-9"
				/>
			</div>

			<div className="mt-4 rounded-2xl border border-neutral-200 bg-white p-2">
				{contacts.isLoading && <SkeletonRows count={5} compact />}
				{contacts.isError && (
					<p role="alert" className="px-4 py-8 text-center text-sm text-red-600">
						{t("contacts.loadFailed")}
					</p>
				)}
				{!contacts.isLoading && !contacts.isError && items.length === 0 && (
					<div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
						<UsersRound className="h-8 w-8 text-neutral-300" />
						<p className="text-sm font-medium text-neutral-700">
							{query ? t("contacts.emptySearch") : t("contacts.empty")}
						</p>
						{!query && <p className="text-xs text-neutral-500">{t("contacts.emptyHint")}</p>}
					</div>
				)}
				<div className="divide-y divide-neutral-100">
					{items.map((contact) => (
						<ContactRow
							key={contact.id}
							mailboxId={mailboxId}
							contact={contact}
							onEmail={(item) => openComposer({ to: [formatEmailAddress(item.email, item.displayName)] })}
							onEdit={(item) => {
								setEditing(item);
								setEditOpen(true);
							}}
							onDelete={setDeleting}
						/>
					))}
				</div>
			</div>

			<ContactEditDialog
				mailboxId={mailboxId}
				contact={editing}
				open={editOpen}
				onOpenChange={setEditOpen}
				onSaved={refresh}
			/>
			<ContactDeleteDialog
				mailboxId={mailboxId}
				contact={deleting}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				onDeleted={refresh}
			/>
		</div>
	);
}
