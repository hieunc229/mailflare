import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { assessStoredAttachment, getAttachmentForUser } from "@/lib/email/attachments";
import { getInlineContentType } from "@/lib/http/content-type";
import type { AttachmentRouteParams } from "./types";
import { getAttachmentContentDisposition } from "./utils";

export async function GET(request: Request, { params }: AttachmentRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });

	const { attachmentId, messageId } = await params;
	const result = await getAttachmentForUser(env, user, messageId, attachmentId);
	if (!result) return new Response("Not found", { status: 404 });

	const { attachment, object } = result;
	const url = new URL(request.url);
	const previewRequested = url.searchParams.get("preview") === "1";
	const downloadRequested = url.searchParams.get("download") === "1";
	// The sender chooses both the type and the disposition, so only types that cannot run script ever render here.
	// The sandbox below is not enough on its own: on the Node runtime Next.js keeps the global CSP from next.config
	// and drops a route's own Content-Security-Policy.
	const inlineType = downloadRequested ? null : getInlineContentType(attachment.contentType);
	const inline = inlineType !== null && (attachment.disposition === "inline" || previewRequested);
	// Types that run code, carry macros or hide other files are downloaded only after the user has seen why.
	const risk = await assessStoredAttachment(env, { filename: attachment.filename, type: attachment.contentType, size: attachment.size, r2Key: attachment.r2Key });
	if (url.searchParams.get("risk") === "1") {
		await object.body.cancel().catch(() => undefined);
		return Response.json(risk, { headers: { "Cache-Control": "private, no-store" } });
	}
	if (!inline && risk.level !== "ok" && url.searchParams.get("acknowledge") !== "1") {
		await object.body.cancel().catch(() => undefined);
		return Response.json({ error: "This file is flagged. Review the warning before downloading it.", risk }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
	}
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("Content-Type", (inline && inlineType) || "application/octet-stream");
	headers.set("Content-Length", String(attachment.size));
	headers.set("Content-Disposition", getAttachmentContentDisposition(attachment.filename, inline));
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set(
		"Content-Security-Policy",
		"default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox",
	);
	headers.set("Cache-Control", "private, max-age=300");

	return new Response(object.body, { headers });
}
