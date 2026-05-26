"use client";

import Link from "next/link";
import { Clock, MailOpen, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useMessages } from "@/hooks/use-messages";
import { useSelectedMailbox } from "@/components/mailbox-provider";

export default function SentPage() {
	const { selectedMailbox } = useSelectedMailbox();
	const { messages, isLoading } = useMessages("sent", selectedMailbox?.id);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-14 items-center justify-between border-b border-neutral-200 px-6">
				<div className="flex items-center gap-3">
					<h1 className="text-xl font-medium text-neutral-800">
						Sent
						{/* {selectedMailbox
							? selectedMailbox.displayName ?? `${selectedMailbox.localPart}@${selectedMailbox.hostname}`
							: "Sent"} */}
					</h1>
					<Badge variant="secondary">{messages.length}</Badge>
				</div>
				<div className="flex items-center gap-2 text-neutral-500">
					<MailOpen className="h-4 w-4" />
					<Clock className="h-4 w-4" />
				</div>
			</div>

			<div className="divide-y divide-neutral-100">
				{isLoading && (
					<p className="px-6 py-4 text-sm text-neutral-500">Loading...</p>
				)}
				{!isLoading && messages.length === 0 && (
					<p className="px-6 py-4 text-sm text-neutral-500">
						No emails
					</p>
				)}
				{messages.map((msg) => (
					<Link
						key={msg.id}
						href={`/sent/${msg.id}`}
						className="grid min-h-12 grid-cols-[32px_minmax(160px,240px)_1fr_auto] items-center gap-3 px-6 text-sm hover:relative hover:z-10 hover:bg-[#f2f6fc] hover:shadow-sm"
					>
						<Send className="h-4 w-4 text-neutral-300" />
						<span className="font-semibold text-neutral-800 truncate">
							{msg.toAddr}
						</span>
						<span className="truncate text-neutral-700">
							<span className="font-medium">
								{msg.subject ?? "(no subject)"}
							</span>
							<span className="text-neutral-500"> - {msg.snippet}</span>
						</span>
						<Badge variant="outline">{msg.direction}</Badge>
					</Link>
				))}
			</div>
		</div>
	);
}
