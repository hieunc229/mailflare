import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders } from "@/db/schema";
import type { routingRuleSchema } from "@/lib/validators";
import type { z } from "zod";
import type { RuleTarget } from "./types";

/**
 * Turns a mailbox rule's `destination` into the columns that store it. Returns an
 * `error` and `status` instead when the destination is missing or not usable.
 */
export async function resolveRuleTarget(
	db: AppDatabase,
	mailboxId: string,
	input: z.infer<typeof routingRuleSchema>,
): Promise<RuleTarget | { error: string; status: number }> {
	const destination = input.destination ?? (input.folderId ? `folder:${input.folderId}` : "");

	if (destination === "forward") {
		// Forwards are actioned while the message is still being received, before its body is
		// available, so a rule that matches on content can never fire.
		if (input.matchField === "content") {
			return { error: "Forwarding rules cannot match on message content", status: 400 };
		}
		if (!input.forwardTo) return { error: "A forwarding address is required", status: 400 };
		return {
			action: "forward",
			folderId: null,
			forwardTo: input.forwardTo,
			keepCopy: input.keepCopy ?? false,
		};
	}

	if (destination === "spam" || destination === "trash") {
		return { action: destination, folderId: null, forwardTo: null, keepCopy: false };
	}

	const folderId = destination.startsWith("folder:") ? destination.slice("folder:".length) : null;
	if (!folderId) return { error: "Destination is required", status: 400 };

	const [folder] = await db
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)))
		.limit(1);
	if (!folder) return { error: "Folder not found", status: 404 };

	return { action: "store", folderId, forwardTo: null, keepCopy: false };
}
