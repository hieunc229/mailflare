import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isOthersDraft } from "@/lib/email/draft-access";
import { parseFollowUpDays } from "@/lib/follow-ups/follow-up-utils";
import { isMissingTableError } from "@/lib/database-errors";
import { getMessageFollowUp, setFollowUp, updateFollowUp } from "@/lib/follow-ups/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

type RouteContext = { params: Promise<{ messageId: string }> };

/** The signed-in user and the sent message, when they may read it. Reminders are personal to the user. */
async function loadSentMessage(request: Request, context: RouteContext) {
	const { messageId } = await context.params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, userId: messages.userId, mailboxId: messages.mailboxId, direction: messages.direction, status: messages.status, privateDraft: messages.privateDraft })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	const access = message?.mailboxId ? await getMailboxAccessLevel(db, user, message.mailboxId) : null;
	if (!message || isOthersDraft(message, user.id) || !access?.canRead) return { error: NextResponse.json({ error: "Message not found" }, { status: 404 }) };
	return { env, user, message };
}

export async function GET(request: Request, context: RouteContext) {
	const loaded = await loadSentMessage(request, context);
	if ("error" in loaded) return loaded.error;
	if (loaded.message.direction !== "outbound") return NextResponse.json({ followUp: null });
	return NextResponse.json({ followUp: await getMessageFollowUp(loaded.env, loaded.user.id, loaded.message.id) });
}

export async function PUT(request: Request, context: RouteContext) {
	const loaded = await loadSentMessage(request, context);
	if ("error" in loaded) return loaded.error;
	if (loaded.message.direction !== "outbound" || loaded.message.status === "draft") {
		return NextResponse.json({ error: "Only sent messages can have a reminder" }, { status: 400 });
	}
	const body = (await request.json().catch(() => null)) as { days?: unknown } | null;
	const days = parseFollowUpDays(body?.days);
	if (!days) return NextResponse.json({ error: "Choose a reminder delay" }, { status: 400 });
	try {
		return NextResponse.json({ followUp: await setFollowUp(loaded.env, { messageId: loaded.message.id, userId: loaded.user.id, days }) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
		throw error;
	}
}

export async function DELETE(request: Request, context: RouteContext) {
	const loaded = await loadSentMessage(request, context);
	if ("error" in loaded) return loaded.error;
	const followUp = await getMessageFollowUp(loaded.env, loaded.user.id, loaded.message.id);
	if (followUp) await updateFollowUp(loaded.env, loaded.user.id, followUp.id, { action: "dismiss" });
	return NextResponse.json({ ok: true });
}
