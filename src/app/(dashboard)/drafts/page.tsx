"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useMessages } from "@/hooks/use-messages";
import { useSelectedMailbox } from "@/components/mailbox-provider";

export default function DraftsPage() {
	const { selectedMailbox } = useSelectedMailbox();
	const { messages, isLoading } = useMessages("drafts", selectedMailbox?.id);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-14 items-center justify-between border-b border-neutral-200 px-6">
				<div className="flex items-center gap-3">
					<h1 className="text-xl font-medium text-neutral-800">Drafts</h1>
					<Badge variant="secondary">{messages.length}</Badge>
				</div>
			</div>

			<div className="divide-y divide-neutral-100">
				{isLoading && <p className="px-6 py-4 text-sm text-neutral-500">Loading...</p>}
				{!isLoading && messages.length === 0 && (
					<p className="px-6 py-4 text-sm text-neutral-500">
						No drafts
					</p>
				)}
				{messages.map((msg) => (
					<Link
						key={msg.id}
						href={`/drafts/${msg.id}`}
						className="grid min-h-12 grid-cols-[32px_minmax(160px,240px)_1fr_auto] items-center gap-3 px-6 text-sm hover:relative hover:z-10 hover:bg-[#f2f6fc] hover:shadow-sm"
					>
						<FileText className="h-4 w-4 text-neutral-300" />
						<span className="truncate font-semibold text-red-600">Draft</span>
						<span className="truncate text-neutral-700">
							<span className="font-medium">{msg.subject ?? "(no subject)"}</span>
							<span className="text-neutral-500"> - {msg.snippet || msg.toAddr || "No content"}</span>
						</span>
						<Badge variant="outline">draft</Badge>
					</Link>
				))}
			</div>
		</div>
	);
}
