"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, UsersRound } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useCompose } from "@/components/compose/compose-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { List } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { formatEmailAddress } from "@/lib/email/address";
import { ContactDeleteDialog } from "./contact-delete-dialog";
import { ContactEditDialog } from "./contact-edit-dialog";
import { ContactRow } from "./contact-row";
import { CONTACT_COLUMNS } from "./contacts-page-utils";
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
		<div className="px-6 py-10 lg:px-12">
		<div className="w-full max-w-3xl space-y-6">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-2xl font-medium md:text-3xl">{t("contacts.title")}</h1>
				<Button type="button" className={mobilePrimaryActionClass} onClick={openCreate} disabled={!mailboxId}>
					<Plus className="h-4 w-4" />
					{t("contacts.add")}
				</Button>
			</div>

			<div className="relative">
				<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
				<Input
					type="search"
					value={input}
					onChange={(event) => setInput(event.target.value)}
					placeholder={t("contacts.search")}
					aria-label={t("contacts.search")}
					className="bg-white pl-9"
				/>
			</div>

			<section className="space-y-3">
				{contacts.isLoading && <SectionRowSkeleton />}
				{contacts.isError && (
					<p role="alert" className="rounded-2xl bg-white px-5 py-4 text-sm text-red-600">
						{t("contacts.loadFailed")}
					</p>
				)}
				{!contacts.isLoading && !contacts.isError && items.length === 0 && (
					<div className="flex flex-col items-center gap-2 rounded-2xl bg-white px-5 py-12 text-center">
						<UsersRound className="h-8 w-8 text-neutral-300" />
						<p className="text-sm font-medium text-neutral-700">
							{query ? t("contacts.emptySearch") : t("contacts.empty")}
						</p>
						{!query && <p className="text-xs text-neutral-500">{t("contacts.emptyHint")}</p>}
					</div>
				)}
				{items.length > 0 && (
					<List>
						<div className={`${CONTACT_COLUMNS} bg-white px-5 py-3 text-xs font-medium uppercase text-neutral-500`}>
							<span className="w-10" />
							<span>{t("common.name")}</span>
							<span className="hidden md:block">{t("contact.lastSeen")}</span>
							<span className="w-[7.5rem]" />
						</div>
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
					</List>
				)}
			</section>
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
