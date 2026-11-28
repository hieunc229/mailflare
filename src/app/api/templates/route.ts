import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { getDraftSender } from "../drafts/utils";

// Templates are outbound messages with status "template": they look like drafts
// in the database but no draft, folder or count query ever selects them.
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const rows = await getDb(env)
		.select({ id: messages.id, subject: messages.subject, htmlBody: messages.htmlBody, textBody: messages.textBody })
		.from(messages)
		.where(and(eq(messages.userId, auth.user.id), eq(messages.status, "template")))
		.orderBy(desc(messages.createdAt))
		.limit(200);
	return NextResponse.json({ templates: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let input: { mailboxId?: string | null; from?: string; title?: string; html?: string; text?: string } | null;
	try {
		input = await readJsonBody(request, 1024 * 1024);
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Template is too large" }, { status: 413 });
		return NextResponse.json({ error: "Enter a title and content." }, { status: 400 });
	}
	const title = typeof input?.title === "string" ? input.title.trim().slice(0, 200) : "";
	const html = typeof input?.html === "string" ? input.html : "";
	const text = typeof input?.text === "string" ? input.text : "";
	if (!title || !(html.trim() || text.trim())) return NextResponse.json({ error: "Enter a title and content." }, { status: 400 });
	const sender = await getDraftSender(env, auth.user.id, { mailboxId: input?.mailboxId, from: input?.from });
	if ("error" in sender) return NextResponse.json({ error: sender.error }, { status: 403 });
	const id = newId("msg");
	await getDb(env).insert(messages).values({
		id,
		userId: auth.user.id,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr: "",
		subject: title,
		snippet: buildSnippet(text || null, html || null),
		textBody: text || null,
		htmlBody: html || null,
		status: "template",
		read: true,
	});
	return NextResponse.json({ template: { id, subject: title, htmlBody: html || null, textBody: text || null } }, { status: 201 });
}
