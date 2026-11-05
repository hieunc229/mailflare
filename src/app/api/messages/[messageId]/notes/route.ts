import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import {
	addConversationNote,
	conversationAnchorForUser,
	CONVERSATION_NOTE_MAX_LENGTH,
	isMessageInConversation,
	listConversationNotes,
} from "@/lib/notes/service";

type RouteContext = { params: Promise<{ messageId: string }> };

/** The signed-in user and the conversation of `messageId`, when they may read its mailbox. */
async function loadConversation(request: Request, context: RouteContext) {
	const { messageId } = await context.params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
	const db = getDb(env);
	const conversation = await conversationAnchorForUser(db, user, messageId);
	if (!conversation) return { error: NextResponse.json({ error: "Message not found" }, { status: 404 }) } as const;
	return { user, db, ...conversation } as const;
}

export async function GET(request: Request, context: RouteContext) {
	const loaded = await loadConversation(request, context);
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ notes: await listConversationNotes(loaded.db, loaded.mailboxId, loaded.threadKey) }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ notes: [] });
		throw error;
	}
}

export async function POST(request: Request, context: RouteContext) {
	const loaded = await loadConversation(request, context);
	if ("error" in loaded) return loaded.error;
	const body = (await request.json().catch(() => null)) as { body?: unknown; messageId?: unknown } | null;
	const text = typeof body?.body === "string" ? body.body.trim() : "";
	if (!text) return NextResponse.json({ error: "Note is empty" }, { status: 400 });
	if (text.length > CONVERSATION_NOTE_MAX_LENGTH) return NextResponse.json({ error: "Note is too long" }, { status: 400 });
	const attachedId = typeof body?.messageId === "string" && body.messageId ? body.messageId : null;
	if (attachedId && !(await isMessageInConversation(loaded.db, loaded.mailboxId, loaded.threadKey, attachedId))) {
		return NextResponse.json({ error: "That email is not in this conversation" }, { status: 400 });
	}
	try {
		return NextResponse.json({ note: await addConversationNote(loaded.db, loaded.mailboxId, loaded.threadKey, text, loaded.user.id, attachedId) }, { status: 201 });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
		throw error;
	}
}
