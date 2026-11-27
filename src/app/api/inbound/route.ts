import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { intakeIncomingMail } from "@/lib/email/intake";
import { verifyInboundSignature, verifyInboundSignatureV2 } from "@/lib/email/intake-signature";
import { inboundAttachmentLimitReasonFromRaw } from "@/lib/email/inbound-attachments";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readRawBody } from "@/lib/http/request";
import { readHeaderMap } from "@/lib/email/provider-trace";
import { RELAY_UPLOAD_OWNER, UPLOAD_KEY_HEADER } from "@/lib/uploads/constants";
import { directUploadsEnabled, readUpload } from "@/lib/uploads/direct";

export const dynamic = "force-dynamic";

const MAX_RELAY_BYTES = 25 * 1024 * 1024;

/**
 * Inbound mail from the Cloudflare email relay Worker (deploy/cloudflare-email-relay).
 * The body is the raw RFC 5322 message; envelope addresses travel in headers and
 * the request is HMAC-signed with INBOUND_WEBHOOK_SECRET. The response tells the
 * relay whether to reject or forward, since only it can act on the live message.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const secret = env.INBOUND_WEBHOOK_SECRET?.trim();
	if (!secret) return NextResponse.json({ error: "INBOUND_WEBHOOK_SECRET is not configured" }, { status: 503 });

	// Unsigned requests are refused before the body is read; the body is then read with a hard cap.
	if (!request.headers.get("x-mailflare-signature")) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
	// A Vercel function cannot receive a large body, so the relay puts such a message in storage first.
	const uploadKey = directUploadsEnabled(env) ? request.headers.get(UPLOAD_KEY_HEADER) : null;
	let raw: ArrayBuffer;
	try {
		raw = uploadKey
			? await readUpload(env, uploadKey, RELAY_UPLOAD_OWNER, MAX_RELAY_BYTES)
			: await readRawBody(request, MAX_RELAY_BYTES);
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Message exceeds the 25 MiB receiving limit" }, { status: 413 });
		throw error;
	}
	const from = request.headers.get("x-mailflare-from") ?? "";
	const to = request.headers.get("x-mailflare-to") ?? "";
	const signature = request.headers.get("x-mailflare-signature") ?? "";
	const headerMap = request.headers.get("x-mailflare-headers") ?? "{}";
	const timestamp = request.headers.get("x-mailflare-timestamp");
	// Relays that send a timestamp sign the header map too and cannot be replayed; older relays only
	// sign the body, which stays accepted unless INBOUND_REQUIRE_SIGNED_HEADERS is set.
	const valid = !from || !to
		? false
		: timestamp
			? await verifyInboundSignatureV2(secret, signature, raw, from, to, headerMap, timestamp)
			: env.INBOUND_REQUIRE_SIGNED_HEADERS !== "1" && await verifyInboundSignature(secret, signature, raw, from, to);
	if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
	// Only a signed request may consume the stored message.
	if (uploadKey) await env.BUCKET.delete(uploadKey);
	if (timestamp) {
		const seenKey = `relay-seen/${signature}`;
		if (await env.BUCKET.head(seenKey)) return NextResponse.json({ error: "Replayed request" }, { status: 409 });
		await env.BUCKET.put(seenKey, new Uint8Array(0));
	}
	const attachmentLimitReason = await inboundAttachmentLimitReasonFromRaw(raw);
	if (attachmentLimitReason) return NextResponse.json({ action: "reject", reason: attachmentLimitReason });

	let headers: Record<string, string> = {};
	try {
		headers = JSON.parse(headerMap) as Record<string, string>;
	} catch {
		// The header map is advisory; the raw message is authoritative.
	}
	// A relay that sends no map (`{}` or no header) still gets the plain headers read from the message.
	if (!headers || Object.keys(headers).length === 0) headers = readHeaderMap(raw);

	// A keep-copy forward rule and account forwarding can both ask for a forward.
	const forwardToAll: string[] = [];
	let forwardHeaders: Record<string, string> = {};
	const result = await intakeIncomingMail(
		env,
		{ from, to, raw, headers },
		{
			// The relay performs the forward on the live message; report it as done so keep-copy applies.
			forward: async (destination, extra) => {
				forwardToAll.push(destination);
				forwardHeaders = extra;
				return true;
			},
		},
	);
	// Relays deployed before forwardToAll only read forwardTo, which keeps its old value (the last one).
	const forwardTo = forwardToAll.at(-1) ?? null;
	return NextResponse.json({ ...result, forwardTo, forwardToAll, forwardHeaders });
}
