import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { messageBodies, messages } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { buildSnippet } from "@/lib/email/parse";

type Params = { params: Promise<{ id: string }> };

type DraftPayload = {
	mailboxId?: string | null;
	from?: string;
	to?: string;
	subject?: string;
	text?: string;
	html?: string;
};

export async function PATCH(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env);
	const input = (await request.json()) as DraftPayload;
	const db = getDb(env);
	const [draft] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);

	if (!draft || draft.userId !== user.id || draft.status !== "draft") {
		return NextResponse.json({ error: "Draft not found" }, { status: 404 });
	}

	const text = input.text ?? "";
	const html = input.html ?? "";
	await db
		.update(messages)
		.set({
			mailboxId: input.mailboxId ?? null,
			fromAddr: input.from ?? "",
			toAddr: input.to ?? "",
			subject: input.subject ?? null,
			snippet: buildSnippet(text || null, html || null),
		})
		.where(eq(messages.id, id));

	await db
		.update(messageBodies)
		.set({
			textBody: text || null,
			htmlBody: html || null,
		})
		.where(eq(messageBodies.messageId, id));

	return NextResponse.json({ draft: { id } });
}

export async function DELETE(_request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env);
	const db = getDb(env);
	const [draft] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);

	if (!draft || draft.userId !== user.id || draft.status !== "draft") {
		return NextResponse.json({ error: "Draft not found" }, { status: 404 });
	}

	await db.delete(messages).where(eq(messages.id, id));
	return NextResponse.json({ ok: true });
}
