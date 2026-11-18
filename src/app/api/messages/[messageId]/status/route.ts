import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { updateMessageStatusForUser } from "@/lib/user";
import type { MessageStatusPayload } from "./types";
import { isAllowedMessageStatus } from "./utils";
import { readJsonObject } from "@/lib/http/request";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const payload = await readJsonObject<MessageStatusPayload>(request);
	if (!payload) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	if (!isAllowedMessageStatus(payload.status)) {
		return NextResponse.json({ error: "Invalid message status" }, { status: 400 });
	}

	const success = await updateMessageStatusForUser(env, user, messageId, payload.status);
	if (!success) {
		return NextResponse.json({ error: "Message not found" }, { status: 404 });
	}

	return NextResponse.json({ success: true });
}
