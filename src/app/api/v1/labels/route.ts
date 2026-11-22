import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { listLabels } from "@/lib/labels/service";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { authenticateLabelsRequest, keyAllowsMailbox } from "./utils";

/** `GET /api/v1/labels?mailboxId=` lists the labels of one mailbox, or of every mailbox the key covers. */
export async function GET(request: Request) {
	const loaded = await authenticateLabelsRequest(request, "read");
	if ("error" in loaded) return loaded.error;
	const { auth, db } = loaded;
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	let mailboxIds: string[];
	if (mailboxId) {
		const access = keyAllowsMailbox(auth, mailboxId) ? await getMailboxAccessLevel(db, auth.user, mailboxId) : null;
		if (!access?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		mailboxIds = [mailboxId];
	} else {
		mailboxIds = (await listAccessibleMailboxIds(db, auth.user)).filter((id) => keyAllowsMailbox(auth, id));
	}
	try {
		return NextResponse.json({ labels: await listLabels(db, mailboxIds) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ labels: [] });
		throw error;
	}
}
