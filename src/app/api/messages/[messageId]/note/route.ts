import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import {
	clearConversationNote,
	conversationAnchorForUser,
	CONVERSATION_NOTE_MAX_LENGTH,
	getConversationNote,
	setConversationNote,
} from "@/lib/notes/service";
import type { SessionUser } from "@/lib/auth/types";
import type { AppDatabase } from "@/db";

type RouteContext = { params: Promise<{ messageId: string }> };

type LoadedConversation = {
	env: CloudflareEnv;
	user: SessionUser;
	db: AppDatabase;
	mailboxId: string;
	threadKey: string;
};

/** The signed-in user and the conversation of `messageId`, when they may read its mailbox. */
async function loadConversation(request: Request, context: RouteContext): Promise<LoadedConversation | { error: NextResponse }> {
	const { messageId } = await context.params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const db = getDb(env);
	const conversation = await conversationAnchorForUser(db, user, messageId);
	if (!conversation) return { error: NextResponse.json({ error: "Message not found" }, { status: 404 }) };
	return { env, user, db, ...conversation };
}

export async function GET(request: Request, context: RouteContext) {
	const loaded = await loadConversation(request, context);
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ note: await getConversationNote(loaded.db, loaded.mailboxId, loaded.threadKey) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ note: null });
		throw error;
	}
}

export async function PUT(request: Request, context: RouteContext) {
	const loaded = await loadConversation(request, context);
	if ("error" in loaded) return loaded.error;
	const body = (await request.json().catch(() => null)) as { html?: unknown } | null;
	const html = typeof body?.html === "string" ? body.html.trim() : "";
	if (!html) return NextResponse.json({ error: "Note is empty" }, { status: 400 });
	if (html.length > CONVERSATION_NOTE_MAX_LENGTH) return NextResponse.json({ error: "Note is too long" }, { status: 400 });
	try {
		return NextResponse.json({ note: await setConversationNote(loaded.db, loaded.mailboxId, loaded.threadKey, html, loaded.user.id) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
		throw error;
	}
}

export async function DELETE(request: Request, context: RouteContext) {
	const loaded = await loadConversation(request, context);
	if ("error" in loaded) return loaded.error;
	try {
		await clearConversationNote(loaded.db, loaded.mailboxId, loaded.threadKey);
		return NextResponse.json({ ok: true });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ ok: true });
		throw error;
	}
}
