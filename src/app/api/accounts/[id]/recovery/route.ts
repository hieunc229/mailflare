import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireTeamAdmin } from "../../utils";
import { canManageUserAccount, isPrimaryAdmin } from "@/lib/auth/admin";
import { selectAccountById } from "../utils";
import { readJsonBody } from "@/lib/http/request";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { authorizeSecurityChange } from "@/lib/auth/webauthn/authorize";
import { bumpSecurityVersion, createEnrollmentGrant } from "@/lib/auth/webauthn/grants";
import { getPublicOrigin } from "@/lib/auth/webauthn/config";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { authError } from "@/lib/http/auth-error";
import type { AccountRouteParams } from "../types";

/**
 * Issues a one-time passkey enrolment link for another account. The
 * administrator must re-authenticate first; the link itself can only enrol a
 * credential and never reads mail.
 */
export async function POST(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const account = await selectAccountById(getDb(access.env), id);
	if (!account) return authError("invalid_request", 404);
	const actor = access.user!;
	if (!isPrimaryAdmin(actor) && !canManageUserAccount(actor, account)) {
		return authError("verification_failed", 403);
	}
	const body = (await readJsonBody(request, 16 * 1024).catch(() => null)) as { password?: string; stepUpToken?: string; code?: string } | null;
	if (!(await authorizeSecurityChange(
		access.env,
		actor,
		getSessionTokenFromRequestHeaders(request),
		body ?? {},
		"admin.recovery_link",
		{ targetUserId: account.id },
	))) {
		return authError("verification_required", 401);
	}
	// A new link supersedes old proofs for this account; issue it against the
	// bumped version so the grant remains valid.
	await bumpSecurityVersion(getDb(access.env), account.id);
	const token = await createEnrollmentGrant(access.env, { userId: account.id, kind: "admin", createdByUserId: actor.id });
	await createAuditLog(access.env, {
		actorUserId: actor.id,
		targetUserId: account.id,
		action: "auth.admin_recovery_created",
		metadata: { ipAddress: request.headers.get("cf-connecting-ip") ?? "unknown" },
	});
	const origin = getPublicOrigin(access.env, request);
	return NextResponse.json(
		{ ok: true, link: `${origin}/setup/passkey?token=${encodeURIComponent(token)}`, expiresInMinutes: 30 },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
