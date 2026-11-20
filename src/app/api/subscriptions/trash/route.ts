import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { previewSenderTrash, trashSenderMessages } from "@/lib/promotions/subscriptions";
import { parseTrashBody } from "@/lib/promotions/subscriptions-utils";
import { authorizeMutation, checkManagedMailbox, isMissingSchema, MIGRATION_REQUIRED } from "@/lib/promotions/route-guards";

/**
 * Subscriptions "Trash all". Bounded: at most 500 of the sender's newest rows from the last 90 days per request
 * (see trashSenderMessages). `previewOnly` reports `{ count, willChange, olderLeft }`; a real run reports
 * `{ changed, remaining }` with the rows it really moved. Mail is moved to Trash, never deleted.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authorizeMutation(env, request);
	if (auth.error) return auth.error;
	const parsed = parseTrashBody(await request.json().catch(() => null));
	if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
	const db = getDb(env);
	const denied = await checkManagedMailbox(db, auth.user, parsed.mailboxId);
	if (denied) return denied;

	try {
		if (parsed.previewOnly) return NextResponse.json(await previewSenderTrash(db, parsed));
		const result = await trashSenderMessages(db, parsed);
		// After the UPDATE, so the log holds what really changed.
		if (result.changed > 0) {
			await createAuditLog(env, { actorUserId: auth.user.id, mailboxId: parsed.mailboxId, action: "email.sender_trash", metadata: { sender: parsed.senderAddress, count: result.changed, remaining: result.remaining } });
		}
		return NextResponse.json(result);
	} catch (error) {
		if (isMissingSchema(error)) return NextResponse.json(MIGRATION_REQUIRED, { status: 409 });
		throw error;
	}
}
