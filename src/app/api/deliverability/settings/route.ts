import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { canManageDomains, isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { isMissingColumnError } from "@/lib/database-errors";
import { getResendEventsSecret } from "@/lib/deliverability/provider-events";
import { getSesFeedState } from "@/lib/deliverability/ses-feed";
import { getSuppressionMode, setSuppressionMode } from "@/lib/deliverability/suppression";

const MIGRATION_REQUIRED = { error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" };
const schema = z.object({ suppressionMode: z.enum(["off", "record", "enforce"]) });

async function view(env: CloudflareEnv, canEdit: boolean) {
	const [mode, resendSecret, ses] = await Promise.all([getSuppressionMode(env), getResendEventsSecret(env), getSesFeedState(env)]);
	return { suppressionMode: mode, canEdit, feeds: { resend: !!resendSecret, ses: ses ? { identities: ses.identities } : null } };
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!canManageDomains(auth.user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	return NextResponse.json(await view(env, isPrimaryAdmin(auth.user)));
}

/** The mode applies to every domain on the installation, so only the primary admin sets it. */
export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
	try {
		await setSuppressionMode(env, parsed.data.suppressionMode);
	} catch (error) {
		if (isMissingColumnError(error)) return NextResponse.json(MIGRATION_REQUIRED, { status: 409 });
		throw error;
	}
	return NextResponse.json(await view(env, true));
}
