import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { deviceTokens } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { deviceRevokeSchema } from "@/lib/validators";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let body: unknown;
	try {
		body = await readJsonBody(request, 4 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request" }, { status });
	}
	const parsed = deviceRevokeSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	await db
		.delete(deviceTokens)
		.where(and(eq(deviceTokens.userId, user.id), eq(deviceTokens.token, parsed.data.token)));

	return NextResponse.json({ ok: true });
}