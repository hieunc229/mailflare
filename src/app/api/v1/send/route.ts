import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { sendEmailSchema } from "@/lib/validators";
import { sendEmail } from "@/lib/email/send";
import { SuppressedRecipientError, suppressedRecipientBody } from "@/lib/deliverability/suppression-utils";
import { decodeBase64Content } from "@/lib/email/attachments";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getSendErrorStatus } from "@/app/api/send/error-utils";

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || !requireScope(auth.scopes, "send")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await readJsonBody(request, 40 * 1024 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid send request" }, { status });
	}
	const parsed = sendEmailSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}
	if (auth.mailboxIds && !auth.mailboxIds.includes(parsed.data.mailboxId)) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	try {
		const { attachments, ...fields } = parsed.data;
		const result = await sendEmail(env, {
			userId: auth.userId,
			...fields,
			publicOrigin: new URL(request.url).origin,
			attachments: attachments?.map((attachment) => ({
				filename: attachment.filename,
				type: attachment.type,
				content: decodeBase64Content(attachment.contentBase64),
				disposition: "attachment",
			})),
		});
		return NextResponse.json(result);
	} catch (err) {
		if (err instanceof SuppressedRecipientError) return NextResponse.json(suppressedRecipientBody(err), { status: 422 });
		const message = err instanceof Error ? err.message : "Send failed";
		return NextResponse.json({ error: message }, { status: getSendErrorStatus(message) });
	}
}
