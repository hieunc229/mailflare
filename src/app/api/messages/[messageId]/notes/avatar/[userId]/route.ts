import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getAvatarImageResponse } from "@/lib/avatar-images";
import { conversationAnchorForUser, noteAuthorAvatarKey } from "@/lib/notes/service";

/** A note author's avatar, for readers of the conversation the author wrote a note on. */
export async function GET(request: Request, { params }: { params: Promise<{ messageId: string; userId: string }> }) {
	const { messageId, userId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });
	const db = getDb(env);
	const conversation = await conversationAnchorForUser(db, user, messageId);
	if (!conversation) return new Response("Not found", { status: 404 });
	const key = await noteAuthorAvatarKey(db, conversation.mailboxId, conversation.threadKey, userId);
	if (!key) return new Response("Not found", { status: 404 });
	return getAvatarImageResponse(request, env.BUCKET, key);
}
