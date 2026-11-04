import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getEmailAddress } from "@/lib/email/address";
import { readSesAuthentication } from "@/lib/email/provider-trace";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { MessageAuthenticationResponse } from "@/lib/email/authentication-types";
import type { MessageAuthenticationRouteParams } from "./types";

/** Authentication headers are in the leading header block, so a partial read is enough. */
const HEADER_SCAN_BYTES = 64 * 1024;

export async function GET(request: Request, { params }: MessageAuthenticationRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const { messageId } = await params;
	const db = getDb(env);
	const [message] = await db
		.select({
			mailboxId: messages.mailboxId,
			direction: messages.direction,
			fromAddr: messages.fromAddr,
			rawR2Key: messages.rawR2Key,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Not found" }, { status: 404 });

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Not found" }, { status: 404 });

	const unavailable = (reason: Extract<MessageAuthenticationResponse, { available: false }>["reason"]) => {
		const response: MessageAuthenticationResponse = { available: false, reason };
		return NextResponse.json(response, { headers: { "Cache-Control": "private, no-store" } });
	};

	// Authentication results describe how a received message reached us; a sent
	// message has no equivalent provider trace.
	if (message.direction !== "inbound") return unavailable("outbound");
	if (!message.rawR2Key) return unavailable("not-retained");

	const object = await env.BUCKET.get(message.rawR2Key, { range: { offset: 0, length: HEADER_SCAN_BYTES } });
	if (!object) return unavailable("unavailable");
	const authentication = readSesAuthentication(await object.arrayBuffer(), getEmailAddress(message.fromAddr));
	if (!authentication) return unavailable("untrusted");

	const response: MessageAuthenticationResponse = { available: true, ...authentication };
	return NextResponse.json(response, { headers: { "Cache-Control": "private, no-store" } });
}
