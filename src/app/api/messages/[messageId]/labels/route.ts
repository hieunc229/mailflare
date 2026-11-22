import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { readJsonObject } from "@/lib/http/request";
import { listConversationLabels, setConversationLabel } from "@/lib/labels/service";
import { loadNoteConversation, migrationRequired } from "../notes/utils";

type RouteContext = { params: Promise<{ messageId: string }> };

/** The labels on the conversation this email belongs to. */
export async function GET(request: Request, context: RouteContext) {
	const loaded = await loadNoteConversation(request, (await context.params).messageId);
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ labels: await listConversationLabels(loaded.db, loaded.conversation) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ labels: [] });
		throw error;
	}
}

/**
 * `{ labelId, applied }` puts a label of the mailbox on the whole conversation
 * or takes it off. It moves nothing, and needs the permission starring needs.
 */
export async function PUT(request: Request, context: RouteContext) {
	const loaded = await loadNoteConversation(request, (await context.params).messageId);
	if ("error" in loaded) return loaded.error;
	if (!loaded.conversation.canChange) return NextResponse.json({ error: "You cannot change messages in this mailbox" }, { status: 403 });
	const body = await readJsonObject<{ labelId?: unknown; applied?: unknown }>(request);
	if (typeof body?.labelId !== "string" || typeof body.applied !== "boolean") {
		return NextResponse.json({ error: "labelId and applied are required" }, { status: 400 });
	}
	try {
		if (!await setConversationLabel(loaded.db, loaded.conversation, body.labelId, body.applied)) {
			return NextResponse.json({ error: "Label not found" }, { status: 404 });
		}
		return NextResponse.json({ labels: await listConversationLabels(loaded.db, loaded.conversation) });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
