import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isOthersDraft } from "@/lib/email/draft-access";
import type { MessageOriginalRouteParams } from "./types";

export async function GET(request: Request, { params }: MessageOriginalRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });

	const { messageId } = await params;
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, userId: messages.userId, status: messages.status, privateDraft: messages.privateDraft, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || isOthersDraft(message, user.id)) return new Response("Message not found", { status: 404 });
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return new Response("Message not found", { status: 404 });
	if (!message.rawR2Key) {
		return new Response("Original source was not retained for this message.", { status: 404 });
	}

	const object = await env.BUCKET.get(message.rawR2Key);
	if (!object) return new Response("Original source is unavailable.", { status: 404 });
	return new Response(object.body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
