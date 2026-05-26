"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMessages } from "@/hooks/use-messages";
import type { MessageListRowProps, MessageFolderConfig } from "./types";
import { getMessageBadge, getMessageParty, getMessagePreview } from "./utils";

function MessageListRow({ message, config }: MessageListRowProps) {
	const Icon = config.icon;
	const unread = message.direction === "inbound" && !message.read;

	return (
		<Link
			href={`${config.hrefPrefix}/${message.id}`}
			className="grid min-h-12 grid-cols-[32px_minmax(160px,240px)_1fr_auto] items-center gap-3 px-6 text-sm hover:relative hover:z-10 hover:bg-[#f2f6fc] hover:shadow-sm"
		>
			<Icon className="h-4 w-4 text-neutral-300" />
			<span
				className={`truncate ${
					unread ? "font-bold text-neutral-900" : "font-semibold text-neutral-800"
				}`}
			>
				{getMessageParty(message, config.folder)}
			</span>
			<span className="truncate text-neutral-700">
				<span className={unread ? "font-bold text-neutral-900" : "font-medium"}>
					{message.subject ?? "(no subject)"}
				</span>
				<span className="text-neutral-500"> - {getMessagePreview(message, config.folder)}</span>
			</span>
			<Badge variant={config.badgeVariant ?? "secondary"}>
				{getMessageBadge(message, config.folder)}
			</Badge>
		</Link>
	);
}

export function MessageFolderPage({ config }: { config: MessageFolderConfig }) {
	const { selectedMailbox } = useSelectedMailbox();
	const { messages, isLoading } = useMessages(config.folder, selectedMailbox?.id);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-14 items-center justify-between border-b border-neutral-200 px-6">
				<div className="flex items-center gap-3">
					<h1 className="text-xl font-medium text-neutral-800">{config.title}</h1>
					<Badge variant="secondary">{messages.length}</Badge>
				</div>
			</div>

			<div className="divide-y divide-neutral-100">
				{isLoading && <p className="px-6 py-4 text-sm text-neutral-500">Loading...</p>}
				{!isLoading && messages.length === 0 && (
					<p className="px-6 py-4 text-sm text-neutral-500">{config.emptyText}</p>
				)}
				{messages.map((message) => (
					<MessageListRow key={message.id} message={message} config={config} />
				))}
			</div>
		</div>
	);
}
