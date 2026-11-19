import type { AttachmentContent } from "@/lib/email/attachment-types";
import { readFormDataBody, readJsonBody } from "@/lib/http/request";
import type { SendRequestPayload } from "./types";
import { parseFollowUpDays } from "@/lib/follow-ups/follow-up-utils";

function getOptionalFormValue(form: FormData, key: string): string | undefined {
	const value = form.get(key);
	return typeof value === "string" && value ? value : undefined;
}

export function isPastSchedule(value: string | undefined, now = Date.now()): boolean {
	if (!value) return false;
	const time = new Date(value).getTime();
	return !Number.isFinite(time) || time < now - 60_000;
}

export async function parseSendRequest(request: Request, maxBytes: number): Promise<SendRequestPayload> {
	if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
		return readJsonBody<SendRequestPayload>(request, maxBytes);
	}

	const form = await readFormDataBody(request, maxBytes);
	const attachments: AttachmentContent[] = [];
	for (const value of form.getAll("attachments")) {
		if (!(value instanceof File) || value.size === 0) continue;
		attachments.push({
			filename: value.name,
			type: value.type || "application/octet-stream",
			content: await value.arrayBuffer(),
			disposition: "attachment",
		});
	}

	return {
		from: String(form.get("from") ?? ""),
		to: String(form.get("to") ?? ""),
		cc: getOptionalFormValue(form, "cc"),
		bcc: getOptionalFormValue(form, "bcc"),
		inReplyTo: getOptionalFormValue(form, "inReplyTo"),
		references: getOptionalFormValue(form, "references"),
		threadId: getOptionalFormValue(form, "threadId"),
		draftId: getOptionalFormValue(form, "draftId"),
		scheduledAt: getOptionalFormValue(form, "scheduledAt"),
		undoSend: form.get("undoSend") === "true",
		trackOpens: form.get("trackOpens") === "true",
		followUpDays: parseFollowUpDays(form.get("followUpDays")) ?? undefined,
		subject: String(form.get("subject") ?? ""),
		text: getOptionalFormValue(form, "text"),
		html: getOptionalFormValue(form, "html"),
		mailboxId: getOptionalFormValue(form, "mailboxId"),
		attachments,
	};
}
