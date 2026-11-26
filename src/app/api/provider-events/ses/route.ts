import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { MAX_EVENT_BYTES, processSesFeedback } from "@/lib/deliverability/provider-events";
import { assertRequestSize } from "@/lib/http/request";

export const dynamic = "force-dynamic";

/** SES bounce and complaint notifications over SNS (SNS posts JSON as text/plain). Public; token, topic and SNS signature are checked. */
export async function POST(request: Request) {
	try { assertRequestSize(request, MAX_EVENT_BYTES); } catch { return NextResponse.json({ error: "Body too large" }, { status: 413 }); }
	const result = await processSesFeedback(getEnv(), {
		token: new URL(request.url).searchParams.get("token") ?? "",
		body: await request.text(),
	});
	return NextResponse.json(result.body, { status: result.status });
}
