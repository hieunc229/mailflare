import { eq } from "drizzle-orm";
import type { getDb } from "@/db";
import { messageBodies, messages } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

export function selectDraftWithBody(db: Db, userId: string, draftId: string) {
	return db
		.select({
			id: messages.id,
			userId: messages.userId,
			mailboxId: messages.mailboxId,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			subject: messages.subject,
			status: messages.status,
			textBody: messageBodies.textBody,
			htmlBody: messageBodies.htmlBody,
		})
		.from(messages)
		.leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
		.where(eq(messages.id, draftId))
		.limit(1)
		.then(([draft]) => (draft && draft.userId === userId && draft.status === "draft" ? draft : null));
}
