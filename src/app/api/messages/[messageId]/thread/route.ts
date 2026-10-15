import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMessageThreadForUser } from "@/lib/email/thread-view";
import { getThreadNoteForMessage } from "@/lib/email/thread-note";

type MessageRouteParams = {
	params: Promise<{ messageId: string }>;
};

/** Every message in the same conversation as `messageId`, oldest first, with bodies. */
export async function GET(request: Request, { params }: MessageRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { messageId } = await params;
	const data = await getMessageThreadForUser(env, user, messageId);
	if (!data) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	const note = await getThreadNoteForMessage(env, user, messageId);

	return NextResponse.json({ ...data, note: note === "missing" ? null : note });
}
