import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readJsonObject } from "@/lib/http/request";
import { createUploadTicket, directUploadsEnabled, MAX_UPLOAD_BYTES } from "@/lib/uploads/direct";

export const dynamic = "force-dynamic";

/** A presigned URL for one large request body (Vercel only; see src/lib/uploads/constants.ts). */
export async function POST(request: Request) {
	const env = getEnv();
	if (!directUploadsEnabled(env)) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const size = (await readJsonObject<{ size?: unknown }>(request))?.size;
	if (typeof size !== "number" || !Number.isInteger(size) || size < 1) return NextResponse.json({ error: "Invalid upload size" }, { status: 400 });
	if (size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "File is too large" }, { status: 413 });
	return NextResponse.json(await createUploadTicket(env, user.id, size));
}
