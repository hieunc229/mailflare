import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { deleteConversationNote, updateConversationNote } from "@/lib/notes/service";
import { loadNoteConversation, migrationRequired, noteChangeError, readNoteHtml } from "../utils";

type RouteContext = { params: Promise<{ messageId: string; noteId: string }> };

/** Replaces the text of the caller's own note. */
export async function PATCH(request: Request, context: RouteContext) {
	const { messageId, noteId } = await context.params;
	const loaded = await loadNoteConversation(request, messageId);
	if ("error" in loaded) return loaded.error;
	const input = await readNoteHtml(request);
	if ("error" in input) return input.error;
	try {
		const result = await updateConversationNote(loaded.db, loaded.conversation, loaded.user.id, noteId, input.html);
		return result.ok ? NextResponse.json({ note: result.note }) : noteChangeError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

export async function DELETE(request: Request, context: RouteContext) {
	const { messageId, noteId } = await context.params;
	const loaded = await loadNoteConversation(request, messageId);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await deleteConversationNote(loaded.db, loaded.conversation, loaded.user.id, noteId);
		return result.ok ? NextResponse.json({ ok: true }) : noteChangeError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
