import { getEnv } from "@/lib/cloudflare";
import { getAvatarImageResponse } from "@/lib/avatar-images";
import { noteAuthorAvatarKey } from "@/lib/notes/service";
import { loadNoteConversation } from "../../utils";

type RouteContext = { params: Promise<{ messageId: string; userId: string }> };

/** Profile picture of someone who wrote a note in this conversation; nobody else's is served. */
export async function GET(request: Request, context: RouteContext) {
	const { messageId, userId } = await context.params;
	const loaded = await loadNoteConversation(request, messageId);
	if ("error" in loaded) return loaded.error;
	const avatarKey = await noteAuthorAvatarKey(loaded.db, loaded.conversation, userId);
	if (!avatarKey) return new Response("Not found", { status: 404 });
	return getAvatarImageResponse(request, getEnv().BUCKET, avatarKey);
}
