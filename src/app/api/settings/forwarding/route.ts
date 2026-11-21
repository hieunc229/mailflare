import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { bumpSecurityVersion } from "@/lib/auth/webauthn/grants";
import { authorizeSecurityChange } from "@/lib/auth/webauthn/authorize";
import { authError } from "@/lib/http/auth-error";
import { getEnv } from "@/lib/cloudflare";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import type { UpdateForwardingEmailInput } from "./types";
import { parseUpdateForwardingEmailRequest } from "./utils";

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let input: UpdateForwardingEmailInput;
	try {
		input = await parseUpdateForwardingEmailRequest(request);
	} catch (error) {
		if (error instanceof ZodError) {
			return NextResponse.json({ error: error.flatten() }, { status: 400 });
		}
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}

	if (!(await getLicenseEntitlements(env)).canForwardEmail) {
		return NextResponse.json({ error: "A Pro or Team license is required for email forwarding" }, { status: 403 });
	}

	// A forwarding address receives a copy of all mail: changing it needs a password or step-up proof.
	const changed = input.forwardingEmail !== user.forwardingEmail;
	if (changed && !(await authorizeSecurityChange(env, user, getSessionTokenFromRequestHeaders(request), input, "profile.recovery_email"))) {
		return authError("verification_failed", 401);
	}

	const db = getDb(env);
	await db
		.update(users)
		.set({ forwardingEmail: input.forwardingEmail })
		.where(eq(users.id, user.id));
	if (changed) await bumpSecurityVersion(db, user.id);

	return NextResponse.json({ forwardingEmail: input.forwardingEmail });
}
