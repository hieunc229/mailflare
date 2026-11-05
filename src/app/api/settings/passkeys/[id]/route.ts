import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { passkeyRenameSchema, stepUpTokenSchema } from "@/lib/validators";
import { hasPasswordHash } from "@/lib/auth/password";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { bumpSecurityVersion, consumeStepUpGrant } from "@/lib/auth/webauthn/grants";
import { countPasskeys, deletePasskey, renamePasskey } from "@/lib/auth/webauthn/credentials";
import { recordAuthActivity } from "@/lib/auth/activity";
import { getDb } from "@/db";
import { authError, isLastAuthMethodError } from "@/lib/http/auth-error";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const parsed = passkeyRenameSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("invalid_request", 400);
	const { id } = await params;
	if (!(await renamePasskey(env, auth.user.id, id, parsed.data.name))) {
		return authError("passkey_not_found", 404);
	}
	await recordAuthActivity(env, { action: "auth.passkey_renamed", userId: auth.user.id, request });
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const parsed = stepUpTokenSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	if (!parsed.success || !sessionToken) return authError("verification_required", 400);

	const count = await countPasskeys(env, auth.user.id);
	const passwordless = !hasPasswordHash(auth.user.passwordHash);
	// Friendly pre-check; the database trigger remains the final guard.
	if (count <= 1 && passwordless) return authError("last_method", 409);

	if (!(await consumeStepUpGrant(env, {
		token: parsed.data.stepUpToken,
		userId: auth.user.id,
		sessionToken,
		action: "passkey.remove",
	}))) {
		return authError("verification_required", 401);
	}
	const { id } = await params;
	try {
		if (!(await deletePasskey(env, auth.user.id, id))) {
			return authError("passkey_not_found", 404);
		}
		await bumpSecurityVersion(getDb(env), auth.user.id);
	} catch (error) {
		if (isLastAuthMethodError(error)) return authError("last_method", 409);
		throw error;
	}
	await recordAuthActivity(env, { action: "auth.passkey_removed", userId: auth.user.id, request });
	return NextResponse.json({ ok: true });
}
