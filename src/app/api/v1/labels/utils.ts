import { NextResponse } from "next/server";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import type { ApiAuthResult } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { conversationForUser } from "@/lib/notes/service";
import type { NoteConversation } from "@/lib/notes/types";

/** The scope that lets a key put labels on conversations and take them off. `read` only sees them. */
export const LABELS_WRITE_SCOPE = "labels:write";

/** The key, when it carries `scope` and its user is active; otherwise the response to send. */
export async function authenticateLabelsRequest(request: Request, scope: "read" | typeof LABELS_WRITE_SCOPE): Promise<{ auth: ApiAuthResult; db: AppDatabase } | { error: NextResponse }> {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || auth.user.disabled) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	if (!requireScope(auth.scopes, scope)) {
		return { error: NextResponse.json({ error: `This key needs the ${scope} scope` }, { status: 403 }) };
	}
	return { auth, db: getDb(env) };
}

/** A key limited to some mailboxes sees nothing in the others. */
export const keyAllowsMailbox = (auth: ApiAuthResult, mailboxId: string) => !auth.mailboxIds || auth.mailboxIds.includes(mailboxId);

/** The conversation of `messageId`, when the key's user may read it and the key covers its mailbox. */
export async function loadKeyConversation(db: AppDatabase, auth: ApiAuthResult, messageId: string): Promise<NoteConversation | null> {
	const conversation = await conversationForUser(db, auth.user, messageId);
	return conversation && keyAllowsMailbox(auth, conversation.mailboxId) ? conversation : null;
}
