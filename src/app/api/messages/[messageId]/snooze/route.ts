import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SnoozeMessagePayload } from "./types";
import { getSnoozedUntil } from "./utils";
import { readJsonObject } from "@/lib/http/request";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const payload = await readJsonObject<SnoozeMessagePayload>(request);
	if (!payload) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const snoozedUntil = getSnoozedUntil(payload.snoozedUntil);
	if (!snoozedUntil) {
		return NextResponse.json({ error: "Choose a future snooze time" }, { status: 400 });
	}

	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, status: messages.status })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.direction, "inbound")))
		.limit(1);
	if (!message?.mailboxId || message.status !== "received") {
		return NextResponse.json({ error: "Message not found" }, { status: 404 });
	}

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canManage) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	await db
		.update(messages)
		.set({ snoozedUntil })
		.where(eq(messages.id, message.id));

	return NextResponse.json({ ok: true });
}

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ messageId: string }> },
) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.direction, "inbound")))
		.limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canManage) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	await db.update(messages).set({ snoozedUntil: null }).where(eq(messages.id, message.id));
	return NextResponse.json({ ok: true });
}
