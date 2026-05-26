"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useCompose } from "@/components/compose/compose-context";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMessages } from "@/hooks/use-messages";
import type { MessageListRowProps, MessageFolderConfig } from "./types";
import {
	getMessageBadge,
	getMessageParty,
	getMessagePartyClassName,
	getMessagePreview,
} from "./utils";

function MessageListRow({ message, config }: MessageListRowProps) {
	const Icon = config.icon;
	const { openDraftComposer } = useCompose();
	const unread = message.direction === "inbound" && !message.read;
	const className =
		"grid min-h-12 w-full grid-cols-[32px_minmax(160px,240px)_1fr_auto] items-center gap-3 px-6 text-left text-sm hover:relative hover:z-10 hover:bg-[#f2f6fc] hover:shadow-sm";
	const content = (
		<>
			<Icon className="h-4 w-4 text-neutral-300" />
			<span className={getMessagePartyClassName(message, config.folder)}>
				{getMessageParty(message, config.folder)}
			</span>
			<span className="truncate text-neutral-700">
				<span className={unread ? "font-bold text-neutral-900" : "font-medium"}>
					{message.subject ?? "(no subject)"}
				</span>
				<span className="text-neutral-500"> - {getMessagePreview(message, config.folder)}</span>
			</span>
			{config.showRowBadge !== false && (
				<Badge variant={config.badgeVariant ?? "secondary"}>
					{getMessageBadge(message, config.folder)}
				</Badge>
			)}
		</>
	);

	if (config.folder === "drafts") {
		return (
			<button type="button" className={className} onClick={() => openDraftComposer(message.id)}>
				{content}
			</button>
		);
	}

	return (
		<Link href={`${config.hrefPrefix}/${message.id}`} className={className}>
			{content}
		</Link>
	);
}

export function MessageFolderPage({ config }: { config: MessageFolderConfig }) {
	const { selectedMailbox } = useSelectedMailbox();
	const { query } = useMailSearch();
	const { messages, isLoading } = useMessages(config.folder, selectedMailbox?.id, { query });
	const headerIcons = config.headerIcons ?? [];
	const hasActiveFilters = !!query.trim();

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-14 items-center justify-between border-b border-neutral-200 px-6">
				<div className="flex items-center gap-3">
					<h1 className="text-xl font-medium text-neutral-800">{config.title}</h1>
					<Badge variant="secondary">{messages.length}</Badge>
				</div>
				{headerIcons.length > 0 && (
					<div className="flex items-center gap-2 text-neutral-500">
						{headerIcons.map((Icon, index) => (
							<Icon key={index} className="h-4 w-4" />
						))}
					</div>
				)}
			</div>

			<div className="divide-y divide-neutral-100">
				{messages.map((message) => (
					<MessageListRow key={message.id} message={message} config={config} />
				))}
				{isLoading && <p className="px-6 py-4 text-sm text-neutral-500">Loading...</p>}
				{!isLoading && messages.length === 0 && (
					<p className="px-6 py-4 text-sm text-neutral-500">
						{hasActiveFilters ? "No messages match these filters" : config.emptyText}
					</p>
				)}
			</div>
		</div>
	);
}
