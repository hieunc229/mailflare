import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { readJsonBody } from "@/lib/http/request";
import { copyMessageAttachments } from "@/lib/email/attachments";
import { isOthersDraft } from "@/lib/email/draft-access";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import type { DraftPayload } from "./types";
import { getDraftSender } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const db = getDb(env);
	const conditions = [
		eq(messages.userId, user.id),
		eq(messages.direction, "outbound" as const),
		eq(messages.status, "draft"),
	];
	if (mailboxId) conditions.push(eq(messages.mailboxId, mailboxId));

	const rows = await db
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(desc(messages.createdAt))
		.limit(100);

	return NextResponse.json({ drafts: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let input: DraftPayload;
	try {
		input = await readJsonBody<DraftPayload>(request, 1024 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid draft request" }, { status });
	}
	const db = getDb(env);
	const sender = await getDraftSender(env, user.id, input);
	if ("error" in sender) {
		return NextResponse.json({ error: sender.error }, { status: 403 });
	}
	// Forwarding: the source must be readable by this user before its files are copied.
	let forwardSourceId: string | null = null;
	if (input.forwardOfMessageId) {
		const [source] = await db
			.select({ id: messages.id, userId: messages.userId, status: messages.status, privateDraft: messages.privateDraft, mailboxId: messages.mailboxId })
			.from(messages)
			.where(eq(messages.id, input.forwardOfMessageId))
			.limit(1);
		const sourceAccess = source?.mailboxId ? await getMailboxAccessLevel(db, user, source.mailboxId) : null;
		// Another user's draft in a shared mailbox is not readable by this user, so it cannot be forwarded either.
		if (!source || !sourceAccess?.canRead || isOthersDraft(source, user.id)) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}
		forwardSourceId = source.id;
	}

	const draftId = newId("msg");
	const text = input.text ?? "";
	const html = input.html ?? "";

	await db.insert(messages).values({
		id: draftId,
		userId: user.id,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr: input.to ?? "",
		ccAddr: input.cc || null,
		bccAddr: input.bcc || null,
		subject: input.subject ?? null,
		snippet: buildSnippet(text || null, html || null),
		textBody: text || null,
		htmlBody: html || null,
		status: "draft",
		privateDraft: true,
		read: true,
		inReplyTo: input.inReplyTo || null,
		references: input.references || null,
		threadId: input.threadId || null,
	});

	const attachments = forwardSourceId ? await copyMessageAttachments(env, forwardSourceId, draftId) : [];
	return NextResponse.json({ draft: { id: draftId, attachments } });
}
