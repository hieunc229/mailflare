"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical, Reply, ShieldAlert, Trash2 } from "lucide-react";
import type { MessageActionsProps, MessageActionStatus } from "./types";
import { updateMessageFolder } from "./utils";

export function MessageActions({ messageId, direction, status }: MessageActionsProps) {
	const router = useRouter();
	const [pendingStatus, setPendingStatus] = useState<MessageActionStatus | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function moveToFolder(nextStatus: MessageActionStatus) {
		setPendingStatus(nextStatus);
		setError(null);
		try {
			await updateMessageFolder(messageId, nextStatus);
			router.push(nextStatus === "trash" ? "/trash" : "/spam");
			router.refresh();
		} catch {
			setError("Could not update message");
		} finally {
			setPendingStatus(null);
		}
	}

	return (
		<div className="flex items-center gap-3 text-neutral-600">
			{error && <span className="text-xs text-red-600">{error}</span>}
			<div className="flex items-center gap-6">
				<button
					type="button"
					aria-label="Reply"
					className="rounded-full p-1 hover:bg-neutral-100"
				>
					<Reply className="h-5 w-5" />
				</button>
				<button
					type="button"
					aria-label="Report spam"
					disabled={pendingStatus !== null || status === "spam" || direction !== "inbound"}
					onClick={() => moveToFolder("spam")}
					className="rounded-full p-1 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300"
				>
					<ShieldAlert className="h-5 w-5" />
				</button>
				<button
					type="button"
					aria-label="Move to trash"
					disabled={pendingStatus !== null || status === "trash"}
					onClick={() => moveToFolder("trash")}
					className="rounded-full p-1 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300"
				>
					<Trash2 className="h-5 w-5" />
				</button>
				<span aria-label="More actions" className="rounded-full p-1">
					<MoreVertical className="h-5 w-5" />
				</span>
			</div>
		</div>
	);
}
