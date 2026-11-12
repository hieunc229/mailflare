import { NextResponse } from "next/server";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";
import { CONVERSATION_NOTE_MAX_LENGTH, conversationForUser } from "@/lib/notes/service";
import type { NoteConversation } from "@/lib/notes/types";

export type LoadedNoteConversation = {
	user: SessionUser;
	db: AppDatabase;
	conversation: NoteConversation;
};

/** The signed-in user and the conversation of `messageId`, when they may read its mailbox. */
export async function loadNoteConversation(request: Request, messageId: string): Promise<LoadedNoteConversation | { error: NextResponse }> {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const db = getDb(env);
	const conversation = await conversationForUser(db, user, messageId);
	if (!conversation) return { error: NextResponse.json({ error: "Message not found" }, { status: 404 }) };
	return { user, db, conversation };
}

/** The trimmed `html` of a request body, or the response to send when it is missing or too long. */
export async function readNoteHtml(request: Request): Promise<{ html: string; attachToMessage: boolean } | { error: NextResponse }> {
	const body = (await request.json().catch(() => null)) as { html?: unknown; attachToMessage?: unknown } | null;
	const html = typeof body?.html === "string" ? body.html.trim() : "";
	if (!html) return { error: NextResponse.json({ error: "Note is empty" }, { status: 400 }) };
	if (html.length > CONVERSATION_NOTE_MAX_LENGTH) return { error: NextResponse.json({ error: "Note is too long" }, { status: 400 }) };
	return { html, attachToMessage: body?.attachToMessage === true };
}

export const migrationRequired = () =>
	NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });

export function noteChangeError(error: "not_found" | "forbidden") {
	return error === "forbidden"
		? NextResponse.json({ error: "You cannot change this note" }, { status: 403 })
		: NextResponse.json({ error: "Note not found" }, { status: 404 });
}
