import { exists, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { conversationLabels, labels, messages } from "@/db/schema";

/**
 * Messages whose conversation carries a label of their own mailbox matching
 * `labelFilter`. A conversation is keyed by its thread id, or by the message id
 * when it was never threaded (or before a send rekeyed it), so both are tried.
 */
function conversationHasLabel(labelFilter: SQL): SQL {
	return exists(sql`(SELECT 1 FROM ${conversationLabels} INNER JOIN ${labels} ON ${labels.id} = ${conversationLabels.labelId} WHERE ${conversationLabels.mailboxId} = ${messages.mailboxId} AND (${conversationLabels.threadKey} = ${messages.threadId} OR ${conversationLabels.threadKey} = ${messages.id}) AND ${labelFilter})`);
}

export const hasLabelId = (labelId: string) => conversationHasLabel(sql`${labels.id} = ${labelId}`);

/** `label:name` in search: names match without regard to case. */
export const hasLabelNamed = (name: string) => conversationHasLabel(sql`lower(${labels.name}) = ${name.toLowerCase()}`);
