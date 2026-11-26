import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { bumpSecurityVersion } from "@/lib/auth/webauthn/grants";
import { authorizeSecurityChange } from "@/lib/auth/webauthn/authorize";
import { authError } from "@/lib/http/auth-error";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { syncPersonalIdentity } from "@/lib/profile/sync";
import type { UpdateProfileInput } from "./types";
import { parseUpdateProfileRequest } from "./utils";

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let parsed: UpdateProfileInput;
	try {
		parsed = await parseUpdateProfileRequest(request);
	} catch (err) {
		if (err instanceof ZodError) {
			return NextResponse.json({ error: err.flatten() }, { status: 400 });
		}
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}

	const db = getDb(env);
	const canForwardEmail = (await getLicenseEntitlements(env)).canForwardEmail;
	if (!canForwardEmail && parsed.forwardingEmail && parsed.forwardingEmail !== user.forwardingEmail) {
		return NextResponse.json({ error: "A Pro or Team license is required for email forwarding" }, { status: 403 });
	}
	const forwardingEmail = parsed.forwardingEmail === undefined ? user.forwardingEmail : parsed.forwardingEmail;
	// Where a password reset link or a copy of all mail goes is an account-takeover lever: changing it
	// needs the same proof as a password change (password plus code where required, or a step-up grant).
	const recoveryChanged = parsed.resetEmail !== user.resetEmail || forwardingEmail !== user.forwardingEmail;
	if (recoveryChanged && !(await authorizeSecurityChange(env, user, getSessionTokenFromRequestHeaders(request), parsed, "profile.recovery_email"))) {
		return authError("verification_failed", 401);
	}
	if (parsed.name !== undefined) {
		await syncPersonalIdentity(db, {
			userId: user.id,
			name: parsed.name,
			avatarKey: user.avatarKey,
		});
	}
	await db
		.update(users)
		.set({ resetEmail: parsed.resetEmail, forwardingEmail })
		.where(eq(users.id, user.id));
	if (recoveryChanged) await bumpSecurityVersion(db, user.id);

	return NextResponse.json({
		user: {
			id: user.id,
			email: user.email,
			name: parsed.name ?? user.name,
			resetEmail: parsed.resetEmail,
			forwardingEmail,
			canForwardEmail,
		},
	});
}
