import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { updateManagedAccountSchema } from "@/lib/validators";
import { requireTeamAdmin } from "../utils";
import { getAccountSeatError } from "@/lib/licenses/seats";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { canManageUserAccount, canManageUsers, isPrimaryAdmin } from "@/lib/auth/admin";
import type { AccountRouteParams } from "./types";
import { AccountSecurityChangedError, PasskeyOnlyPasswordError, selectAccountById, updateAccountCredentials } from "./utils";
import { deleteUserSessions, getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { hasPasswordHash } from "@/lib/auth/password";
import { consumeStepUpGrant } from "@/lib/auth/webauthn/grants";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { authError } from "@/lib/http/auth-error";

export async function GET(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const account = await selectAccountById(getDb(access.env), id);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const actor = access.user!;
	return NextResponse.json({
		account: {
			id: account.id,
			email: account.email,
			name: account.name,
			role: account.role,
			isPrimaryAdmin: account.isPrimaryAdmin,
			disabled: account.disabled,
			canManageMailboxes: account.canManageMailboxes,
			canManageDomains: account.canManageDomains,
			canManageUsers: account.canManageUsers,
			forwardingEmail: account.forwardingEmail,
			canForwardEmail: (await getLicenseEntitlements(access.env)).canForwardEmail,
			hasAvatar: !!account.avatarKey,
			passwordSet: hasPasswordHash(account.passwordHash),
			editable: canManageUserAccount(actor, account),
			canChangeRole: isPrimaryAdmin(actor),
			canTransferPrimary: isPrimaryAdmin(actor) && !account.isPrimaryAdmin && !account.disabled,
		},
	});
}

export async function PATCH(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const db = getDb(access.env);
	const account = await selectAccountById(db, id);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	if (account.deletedAt) {
		return NextResponse.json({ error: "This account is deleted. Restore it first" }, { status: 409 });
	}
	const actor = access.user!;
	const actorIsPrimary = isPrimaryAdmin(actor);
	if (!actorIsPrimary && !canManageUsers(actor)) {
		return NextResponse.json({ error: "You do not have permission to manage users" }, { status: 403 });
	}
	// Admins without the primary role can only manage plain user accounts.
	if (!canManageUserAccount(actor, account)) {
		return NextResponse.json({ error: "Only the primary admin can manage admin accounts" }, { status: 403 });
	}
	const parsed = updateManagedAccountSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	if (!actorIsPrimary && parsed.data.role !== account.role) {
		return NextResponse.json({ error: "Only the primary admin can change roles" }, { status: 403 });
	}
	const canForwardEmail = (await getLicenseEntitlements(access.env)).canForwardEmail;
	if (!canForwardEmail && parsed.data.forwardingEmail && parsed.data.forwardingEmail !== account.forwardingEmail) {
		return NextResponse.json({ error: "A Pro or Team license is required for email forwarding" }, { status: 403 });
	}
	if (account.disabled && !parsed.data.disabled) {
		const seatError = await getAccountSeatError(access.env);
		if (seatError) return NextResponse.json({ error: seatError }, { status: 403 });
	}
	// A passkey-only account must be recovered through a passkey enrolment link,
	// not by silently giving it a password that bypasses its recovery policy.
	if (parsed.data.password && !hasPasswordHash(account.passwordHash)) {
		return authError("passkey_only_password", 409);
	}
	if (parsed.data.password) {
		const sessionToken = getSessionTokenFromRequestHeaders(request);
		if (!parsed.data.stepUpToken || !sessionToken || !(await consumeStepUpGrant(access.env, {
			token: parsed.data.stepUpToken,
			userId: actor.id,
			sessionToken,
			action: "admin.password_reset",
			targetUserId: id,
		}))) {
			return authError("verification_required", 401);
		}
	}
	try {
		await updateAccountCredentials(db, id, { name: parsed.data.name, password: parsed.data.password ?? null });
	} catch (error) {
		if (error instanceof PasskeyOnlyPasswordError) {
			return authError("passkey_only_password", 409);
		}
		if (error instanceof AccountSecurityChangedError) {
			return authError("action_conflict", 409);
		}
		throw error;
	}
	// A password set by an admin is a reset: whoever held the old one is signed out.
	if (parsed.data.password) {
		await deleteUserSessions(access.env, id);
		await createAuditLog(access.env, {
			actorUserId: actor.id,
			targetUserId: id,
			action: "auth.admin_password_reset",
			metadata: { ipAddress: request.headers.get("cf-connecting-ip") ?? "unknown" },
		});
	}
	// The primary admin always stays an enabled admin; only a transfer can move the role.
	const role = account.isPrimaryAdmin ? "admin" : actorIsPrimary ? parsed.data.role : account.role;
	const disabled = account.isPrimaryAdmin ? false : parsed.data.disabled;
	await db.update(users).set({
		role,
		disabled,
		canManageMailboxes: parsed.data.canManageMailboxes,
		...(actorIsPrimary && parsed.data.canManageDomains !== undefined ? { canManageDomains: parsed.data.canManageDomains } : {}),
		...(actorIsPrimary && parsed.data.canManageUsers !== undefined ? { canManageUsers: parsed.data.canManageUsers } : {}),
		...(parsed.data.forwardingEmail !== undefined ? { forwardingEmail: parsed.data.forwardingEmail } : {}),
	}).where(eq(users.id, id));
	return NextResponse.json({ ok: true });
}
