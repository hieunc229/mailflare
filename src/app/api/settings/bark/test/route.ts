import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { normalizeBarkUrl, sendBarkNotification } from "@/lib/bark/service";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);

	const barkUrl = normalizeBarkUrl(user.barkUrl);
	if (!barkUrl) {
		return NextResponse.json({ error: "No Bark URL configured" }, { status: 400 });
	}

	const ok = await sendBarkNotification(barkUrl, {
		title: "Mailflare Test",
		body: "This is a test notification from Mailflare.",
	});

	if (!ok) {
		return NextResponse.json({ error: "Push failed" }, { status: 502 });
	}

	return NextResponse.json({ ok: true });
}