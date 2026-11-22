import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { listConversationLabels, setConversationLabel } from "@/lib/labels/service";
import { authenticateLabelsRequest, LABELS_WRITE_SCOPE, loadKeyConversation } from "../../../../labels/utils";

type RouteContext = { params: Promise<{ id: string; labelId: string }> };

/** Puts a label of the mailbox on the whole conversation (`PUT`) or takes it off (`DELETE`). Moves nothing. */
async function change(request: Request, { params }: RouteContext, applied: boolean) {
	const loaded = await authenticateLabelsRequest(request, LABELS_WRITE_SCOPE);
	if ("error" in loaded) return loaded.error;
	const { auth, db } = loaded;
	const { id, labelId } = await params;
	const conversation = await loadKeyConversation(db, auth, id);
	if (!conversation) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	// Same floor as starring: a read-only member may see labels but not change them.
	if (!conversation.canChange) return NextResponse.json({ error: "You cannot change messages in this mailbox" }, { status: 403 });
	try {
		if (!await setConversationLabel(db, conversation, labelId, applied)) return NextResponse.json({ error: "Label not found" }, { status: 404 });
		return NextResponse.json({ labels: await listConversationLabels(db, conversation) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
		throw error;
	}
}

export const PUT = (request: Request, context: RouteContext) => change(request, context, true);
export const DELETE = (request: Request, context: RouteContext) => change(request, context, false);
