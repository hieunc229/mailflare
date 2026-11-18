import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import {
	MessageActionError,
	applyMessageActionForUser,
	undoMessageActionForUser,
} from "@/lib/messages/actions/service";
import type { MessageActionInput } from "@/lib/messages/actions/types";

type ActionRequest = (Partial<MessageActionInput> & { op?: "apply" | "undo"; token?: string }) | null;

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const payload = (await request.json().catch(() => null)) as ActionRequest;
	if (!payload) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

	try {
		if (payload.op === "undo") {
			if (typeof payload.token !== "string" || !payload.token) {
				return NextResponse.json({ error: "Undo token is required" }, { status: 400 });
			}
			return NextResponse.json(await undoMessageActionForUser(env, user, payload.token));
		}

		if (!payload.action || !Array.isArray(payload.messageIds)) {
			return NextResponse.json({ error: "Invalid message action" }, { status: 400 });
		}
		return NextResponse.json(await applyMessageActionForUser(env, user, {
			action: payload.action,
			messageIds: payload.messageIds,
			folderId: payload.folderId,
			snoozedUntil: payload.snoozedUntil,
		}));
	} catch (error) {
		if (error instanceof MessageActionError) {
			return NextResponse.json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
}
