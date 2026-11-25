import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMessageThreadForUser } from "@/lib/email/thread-view";

type MessageRouteParams = {
	params: Promise<{ messageId: string }>;
};

/**
 * Every message in the same conversation as `messageId`, oldest first, with
 * bodies. `?bodies=none` leaves the bodies out (`bodyOmitted: true`); fetch one
 * with `GET /api/messages/{id}`, which applies the same mailbox access check.
 */
export async function GET(request: Request, { params }: MessageRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { messageId } = await params;
	const data = await getMessageThreadForUser(env, user, messageId, {
		bodies: new URL(request.url).searchParams.get("bodies") === "none" ? "none" : "all",
	});
	if (!data) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	return NextResponse.json(data);
}
