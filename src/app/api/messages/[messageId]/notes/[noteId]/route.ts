import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { noteHasContent } from "@/lib/notes/html";
import {
	conversationAnchorForUser,
	CONVERSATION_NOTE_MAX_LENGTH,
	deleteConversationNote,
	updateConversationNote,
} from "@/lib/notes/service";

type RouteContext = { params: Promise<{ messageId: string; noteId: string }> };

async function loadConversation(request: Request, context: RouteContext) {
	const { messageId, noteId } = await context.params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
	const db = getDb(env);
	const conversation = await conversationAnchorForUser(db, user, messageId);
	if (!conversation) return { error: NextResponse.json({ error: "Message not found" }, { status: 404 }) } as const;
	return { user, db, noteId, ...conversation } as const;
}

/** Edits a note. Only the person who wrote it may; anyone else gets the same 404 as a missing note. */
export async function PATCH(request: Request, context: RouteContext) {
	const loaded = await loadConversation(request, context);
	if ("error" in loaded) return loaded.error;
	const body = (await request.json().catch(() => null)) as { body?: unknown } | null;
	const text = typeof body?.body === "string" ? body.body.trim() : "";
	if (!noteHasContent(text)) return NextResponse.json({ error: "Note is empty" }, { status: 400 });
	if (text.length > CONVERSATION_NOTE_MAX_LENGTH) return NextResponse.json({ error: "Note is too long" }, { status: 400 });
	try {
		const note = await updateConversationNote(loaded.db, loaded.mailboxId, loaded.threadKey, loaded.noteId, loaded.user.id, text);
		if (!note) return NextResponse.json({ error: "Note not found" }, { status: 404 });
		return NextResponse.json({ note });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ error: "Note not found" }, { status: 404 });
		throw error;
	}
}

export async function DELETE(request: Request, context: RouteContext) {
	const loaded = await loadConversation(request, context);
	if ("error" in loaded) return loaded.error;
	try {
		if (!(await deleteConversationNote(loaded.db, loaded.mailboxId, loaded.threadKey, loaded.noteId, loaded.user.id))) {
			return NextResponse.json({ error: "Note not found" }, { status: 404 });
		}
		return NextResponse.json({ ok: true });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ error: "Note not found" }, { status: 404 });
		throw error;
	}
}
