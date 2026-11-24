import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { isMissingColumnError } from "@/lib/database-errors";
import { removeResendFeed, setupResendFeed } from "@/lib/deliverability/resend-feed";

const originOf = (env: CloudflareEnv, request: Request) => env.APP_URL?.trim() || new URL(request.url).origin;

async function authorize(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { error: auth.error };
	if (!isPrimaryAdmin(auth.user)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	if (!hasValidSessionMutationOrigin(request)) return { error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env };
}

function failure(error: unknown) {
	if (isMissingColumnError(error)) return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
	return NextResponse.json({ error: error instanceof Error ? error.message : "Resend setup failed" }, { status: 502 });
}

/** Creates the Resend webhook for bounces and complaints. */
export async function POST(request: Request) {
	const { env, error } = await authorize(request);
	if (error) return error;
	try {
		await setupResendFeed(env, originOf(env, request));
		return NextResponse.json({ enabled: true });
	} catch (cause) { return failure(cause); }
}

export async function DELETE(request: Request) {
	const { env, error } = await authorize(request);
	if (error) return error;
	try {
		await removeResendFeed(env);
		return NextResponse.json({ enabled: false });
	} catch (cause) { return failure(cause); }
}
