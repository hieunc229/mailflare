import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { deviceTokens } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { deviceRegisterSchema } from "@/lib/validators";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { newId } from "@/lib/ids";

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
	const parsed = deviceRegisterSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const { token, platform } = parsed.data;

	// Upsert: delete existing then insert, since D1 SQLite has limited ON CONFLICT support with Drizzle
	const [existing] = await db
		.select({ id: deviceTokens.id })
		.from(deviceTokens)
		.where(and(eq(deviceTokens.userId, user.id), eq(deviceTokens.token, token)))
		.limit(1);

	if (existing) {
		await db
			.update(deviceTokens)
			.set({ platform, createdAt: new Date() })
			.where(eq(deviceTokens.id, existing.id));
	} else {
		await db.insert(deviceTokens).values({
			id: newId("dtk"),
			userId: user.id,
			token,
			platform,
		});
	}

	return NextResponse.json({ ok: true });
}