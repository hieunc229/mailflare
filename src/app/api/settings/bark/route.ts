import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { normalizeBarkUrl } from "@/lib/bark/service";
import type { UpdateBarkSettingsInput } from "./types";
import { parseUpdateBarkSettingsRequest } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);

	return NextResponse.json({
		barkUrl: user.barkUrl || "",
	});
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);

	let input: UpdateBarkSettingsInput;
	try {
		input = await parseUpdateBarkSettingsRequest(request);
	} catch (error) {
		if (error instanceof ZodError) {
			return NextResponse.json({ error: error.flatten() }, { status: 400 });
		}
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}

	const barkUrl = normalizeBarkUrl(input.barkUrl);

	await getDb(env)
		.update(users)
		.set({ barkUrl })
		.where(eq(users.id, user.id));

	return NextResponse.json({ barkUrl: barkUrl ?? "" });
}