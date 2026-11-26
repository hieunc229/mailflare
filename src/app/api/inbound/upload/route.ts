import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { verifyUploadRequestSignature } from "@/lib/email/intake-signature";
import { readJsonObject } from "@/lib/http/request";
import { RELAY_UPLOAD_OWNER } from "@/lib/uploads/constants";
import { createUploadTicket, directUploadsEnabled } from "@/lib/uploads/direct";

export const dynamic = "force-dynamic";

const MAX_RELAY_BYTES = 25 * 1024 * 1024;

/**
 * Where the email relay asks for a place to put a message too large to post to `/api/inbound` (Vercel only;
 * elsewhere 404, which tells the relay to post the message directly). Signed with INBOUND_WEBHOOK_SECRET.
 */
export async function POST(request: Request) {
	const env = getEnv();
	if (!directUploadsEnabled(env)) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const secret = env.INBOUND_WEBHOOK_SECRET?.trim();
	if (!secret) return NextResponse.json({ error: "INBOUND_WEBHOOK_SECRET is not configured" }, { status: 503 });
	const size = (await readJsonObject<{ size?: unknown }>(request))?.size;
	if (typeof size !== "number" || !Number.isInteger(size) || size < 1) return NextResponse.json({ error: "Invalid upload size" }, { status: 400 });
	const valid = await verifyUploadRequestSignature(secret, request.headers.get("x-mailflare-signature") ?? "", size, request.headers.get("x-mailflare-timestamp") ?? "");
	if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
	if (size > MAX_RELAY_BYTES) return NextResponse.json({ error: "Message exceeds the 25 MiB receiving limit" }, { status: 413 });
	return NextResponse.json(await createUploadTicket(env, RELAY_UPLOAD_OWNER, size));
}
