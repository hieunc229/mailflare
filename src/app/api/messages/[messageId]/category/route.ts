import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { refileSenderMessages, setSenderOverride } from "@/lib/promotions/refile";
import { parseCategoryMoveBody, targetOf } from "@/lib/promotions/refile-utils";
import { authorizeMutation, checkManagedMailbox, isMissingSchema, MIGRATION_REQUIRED } from "@/lib/promotions/route-guards";

/**
 * Moves one message to Promotions or back to Inbox (stored as the explicit `primary`, which the backfill leaves alone).
 * With `applyToSender` the sender also gets an override and their other recent mail follows, bounded.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
	const { messageId } = await params;
	const env = getEnv();
	const auth = await authorizeMutation(env, request);
	if (auth.error) return auth.error;
	const parsed = parseCategoryMoveBody(await request.json().catch(() => null));
	if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

	const db = getDb(env);
	const [message] = await db.select({ mailboxId: messages.mailboxId, direction: messages.direction, category: messages.category, senderAddress: messages.senderAddress })
		.from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	const denied = await checkManagedMailbox(db, auth.user, message.mailboxId);
	if (denied) return denied;
	if (message.direction !== "inbound") return NextResponse.json({ error: "Only received mail can be moved" }, { status: 400 });
	if (parsed.applyToSender && !message.senderAddress) return NextResponse.json({ error: "This message has no sender address to remember" }, { status: 400 });

	const target = targetOf(parsed.category);
	try {
		await db.update(messages).set({ category: target }).where(eq(messages.id, messageId));
		let changed = message.category === target ? 0 : 1;
		let remainingOlder = 0;
		if (parsed.applyToSender && message.senderAddress) {
			await setSenderOverride(db, { mailboxId: message.mailboxId, senderAddress: message.senderAddress, override: parsed.category, userId: auth.user.id });
			const refiled = await refileSenderMessages(db, { mailboxId: message.mailboxId, senderAddress: message.senderAddress, target });
			changed += refiled.changed;
			remainingOlder = refiled.remainingOlder;
		}
		return NextResponse.json({ category: parsed.category, changed, remainingOlder });
	} catch (error) {
		if (isMissingSchema(error)) return NextResponse.json(MIGRATION_REQUIRED, { status: 409 });
		throw error;
	}
}
