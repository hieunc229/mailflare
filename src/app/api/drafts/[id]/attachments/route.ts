import { eq, sql } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { agentDraftMetadata, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { MAX_ATTACHMENT_COUNT, listMessageAttachments, storeMessageAttachments } from "@/lib/email/attachments";
import { outgoingSizeError, requestBodyLimit } from "@/lib/email/attachment-limits";
import { getOutboundAttachmentMaxMb } from "@/lib/email/attachment-policy";
import { readFormDataBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { resolveUploadedRequest } from "@/lib/uploads/direct";
import { userOwnsDraft } from "../../utils";
import type { DraftAttachmentUploadParams } from "./types";

export async function POST(request: Request, { params }: DraftAttachmentUploadParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const db = getDb(env);
	const [draft] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
	if (!userOwnsDraft(draft, user.id)) return Response.json({ error: "Draft not found" }, { status: 404 });
	const maxMb = await getOutboundAttachmentMaxMb(env);
	let form: FormData;
	try {
		const limit = requestBodyLimit(maxMb);
		form = await readFormDataBody(await resolveUploadedRequest(env, request, user.id, limit), limit);
	}
	catch (error) { return Response.json({ error: "Invalid attachment request" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400 }); }
	const files = form.getAll("attachments").filter((value): value is File => value instanceof File && value.size > 0);
	if (!files.length) return Response.json({ error: "No attachments provided" }, { status: 400 });
	const existing = await listMessageAttachments(env, id);
	if (existing.length + files.length > MAX_ATTACHMENT_COUNT || outgoingSizeError([...existing, ...files].map((file) => file.size), maxMb)) return Response.json({ error: "Draft attachments exceed the allowed count or outgoing size limit" }, { status: 400 });
	try {
		const attachments = await storeMessageAttachments(env, id, await Promise.all(files.map(async (file) => ({ filename: file.name, type: file.type || "application/octet-stream", content: await file.arrayBuffer(), disposition: "attachment" as const }))), { validate: false });
		await db.update(agentDraftMetadata).set({ revision: sql`${agentDraftMetadata.revision} + 1`, humanEditedAt: new Date() }).where(eq(agentDraftMetadata.draftId, id));
		return Response.json({ attachments });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not add attachments" }, { status: 400 });
	}
}
