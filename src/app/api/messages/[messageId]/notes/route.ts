import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { addConversationNote, listConversationNotes } from "@/lib/notes/service";
import { loadNoteConversation, migrationRequired, readNoteHtml } from "./utils";

type RouteContext = { params: Promise<{ messageId: string }> };

export async function GET(request: Request, context: RouteContext) {
	const loaded = await loadNoteConversation(request, (await context.params).messageId);
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ notes: await listConversationNotes(loaded.db, loaded.conversation, loaded.user.id) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ notes: [] });
		throw error;
	}
}

/** Adds a note; `attachToMessage: true` makes it about this email rather than the whole conversation. */
export async function POST(request: Request, context: RouteContext) {
	const loaded = await loadNoteConversation(request, (await context.params).messageId);
	if ("error" in loaded) return loaded.error;
	const input = await readNoteHtml(request);
	if ("error" in input) return input.error;
	try {
		const note = await addConversationNote(loaded.db, loaded.conversation, loaded.user.id, input);
		return NextResponse.json({ note }, { status: 201 });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
