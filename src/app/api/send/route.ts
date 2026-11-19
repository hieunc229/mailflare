import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { sendEmailSchema } from "@/lib/validators";
import { sendEmail } from "@/lib/email/send";
import { isPastSchedule, parseSendRequest } from "./utils";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getSendErrorStatus } from "./error-utils";
import { getDb } from "@/db";
import { agentDraftMetadata, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { loadMessageAttachmentContents } from "@/lib/email/attachments";
import { userOwnsDraft } from "@/app/api/drafts/utils";
import { getRequestLocale } from "@/lib/i18n/server";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let input;
	try {
		input = await parseSendRequest(request);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid send request" }, { status });
	}
	const { attachments = [], draftId, ...fields } = input;
	const parsed = sendEmailSchema.omit({ attachments: true }).safeParse(fields);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	if (isPastSchedule(parsed.data.scheduledAt)) {
		return NextResponse.json({ error: "Scheduled time has already passed" }, { status: 400 });
	}

	// Files already stored on the draft (a forwarded message's attachments) ride
	// along with whatever the composer uploaded in this request.
	if (draftId) {
		const db = getDb(env);
		const [draft] = await db.select().from(messages).where(eq(messages.id, draftId)).limit(1);
		if (!userOwnsDraft(draft, user.id)) {
			return NextResponse.json({ error: "Draft not found" }, { status: 404 });
		}
		const [agent] = await db.select({ draftId: agentDraftMetadata.draftId }).from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, draftId)).limit(1);
		if (agent) return NextResponse.json({ error: "Review and confirm this AI draft before sending" }, { status: 409 });
		attachments.push(...(await loadMessageAttachmentContents(env, draftId)));
	}

	try {
		const result = await sendEmail(env, {
			userId: user.id,
			...parsed.data,
			attachments,
			publicOrigin: new URL(request.url).origin,
			locale: await getRequestLocale(),
		});
		return NextResponse.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Send failed";
		return NextResponse.json({ error: message }, { status: getSendErrorStatus(message) });
	}
}
