import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { listConversationLabels } from "@/lib/labels/service";
import { authenticateLabelsRequest, loadKeyConversation } from "../../../labels/utils";

/** `GET /api/v1/messages/[id]/labels`: the labels on the conversation the email belongs to. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const loaded = await authenticateLabelsRequest(request, "read");
	if ("error" in loaded) return loaded.error;
	const conversation = await loadKeyConversation(loaded.db, loaded.auth, (await params).id);
	if (!conversation) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	try {
		return NextResponse.json({ labels: await listConversationLabels(loaded.db, conversation) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ labels: [] });
		throw error;
	}
}
