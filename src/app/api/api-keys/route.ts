import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import { newId } from "@/lib/ids";

const createKeySchema = z.object({
	name: z.string().min(1),
	scopes: z.array(z.enum(["send", "read"])).min(1),
});

export async function GET() {
	const env = getEnv();
	const user = await requireUser(env);
	const db = getDb(env);
	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			scopes: apiKeys.scopes,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
		})
		.from(apiKeys)
		.where(eq(apiKeys.userId, user.id));
	return NextResponse.json({ apiKeys: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env);
	const parsed = createKeySchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const { fullKey, prefix, hash } = generateApiKey();
	const db = getDb(env);
	const id = newId("key");
	await db.insert(apiKeys).values({
		id,
		userId: user.id,
		name: parsed.data.name,
		prefix,
		keyHash: hash,
		scopes: scopesToJson(parsed.data.scopes),
	});

	return NextResponse.json({ id, name: parsed.data.name, prefix, key: fullKey });
}
