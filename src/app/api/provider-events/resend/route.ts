import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { MAX_EVENT_BYTES, processResendEvent } from "@/lib/deliverability/provider-events";
import { assertRequestSize } from "@/lib/http/request";

export const dynamic = "force-dynamic";

/** Resend `email.bounced` and `email.complained`. Public; authenticated by the Svix signature of the events webhook. */
export async function POST(request: Request) {
	try { assertRequestSize(request, MAX_EVENT_BYTES); } catch { return NextResponse.json({ error: "Body too large" }, { status: 413 }); }
	const result = await processResendEvent(getEnv(), {
		body: await request.text(),
		headers: {
			id: request.headers.get("svix-id"),
			timestamp: request.headers.get("svix-timestamp"),
			signature: request.headers.get("svix-signature"),
		},
	});
	return NextResponse.json(result.body, { status: result.status });
}
