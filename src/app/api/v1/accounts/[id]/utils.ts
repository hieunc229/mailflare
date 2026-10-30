import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticateAdminApiKey, canManageAdminAccounts } from "@/lib/api/admin-auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { updateManagedAccountSchema } from "@/lib/validators";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { AccountSecurityChangedError, PasskeyOnlyPasswordError, selectAccountById, updateAccountCredentials } from "@/app/api/accounts/[id]/utils";
import { deleteUserSessions } from "@/lib/auth/session";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { AdminAccountRouteParams } from "./types";

export async function GET(request: Request, { params }: AdminAccountRouteParams) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!(await canManageAdminAccounts(env))) return NextResponse.json({ error: "A Pro or Team license is required to manage accounts" }, { status: 403 });
	const { id } = await params;
	const account = await selectAccountById(getDb(env), id);
	if (!account || (account.id !== auth.userId && account.createdByUserId !== auth.userId)) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	return NextResponse.json({ account: {
		id: account.id, email: account.email, name: account.name, role: account.role,
		disabled: account.disabled, canManageMailboxes: account.canManageMailboxes,
		forwardingEmail: account.forwardingEmail, hasAvatar: !!account.avatarKey,
	} });
}

export async function PATCH(request: Request, { params }: AdminAccountRouteParams) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!(await canManageAdminAccounts(env))) return NextResponse.json({ error: "A Pro or Team license is required to manage accounts" }, { status: 403 });
	const { id } = await params;
	const db = getDb(env);
	const account = await selectAccountById(db, id);
	if (!account || (account.id !== auth.userId && account.createdByUserId !== auth.userId)) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	const parsed = updateManagedAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	if (!isPrimaryAdmin(auth.user) && (account.isPrimaryAdmin || account.role === "admin" || parsed.data.role !== account.role)) {
		return NextResponse.json({ error: "Only the primary admin can manage admin accounts" }, { status: 403 });
	}
	const canForwardEmail = (await getLicenseEntitlements(env)).canForwardEmail;
	if (!canForwardEmail && parsed.data.forwardingEmail && parsed.data.forwardingEmail !== account.forwardingEmail) return NextResponse.json({ error: "A Pro or Team license is required for email forwarding" }, { status: 403 });
	try {
		await updateAccountCredentials(db, id, { name: parsed.data.name, password: parsed.data.password ?? null });
	} catch (error) {
		if (error instanceof PasskeyOnlyPasswordError) {
			return NextResponse.json({ error: "This account uses passkeys only. Send it a recovery link instead.", code: "passkey_only_password" }, { status: 409 });
		}
		if (error instanceof AccountSecurityChangedError) {
			return NextResponse.json({ error: "Another security change is in progress. Refresh and try again.", code: "action_conflict" }, { status: 409 });
		}
		throw error;
	}
	if (parsed.data.password) {
		await deleteUserSessions(env, id);
		await createAuditLog(env, {
			actorUserId: auth.userId,
			targetUserId: id,
			action: "auth.admin_password_reset",
			metadata: { ipAddress: request.headers.get("cf-connecting-ip") ?? "unknown" },
		});
	}
	await db.update(users).set({
		role: account.isPrimaryAdmin ? "admin" : parsed.data.role,
		disabled: account.isPrimaryAdmin ? false : parsed.data.disabled,
		canManageMailboxes: parsed.data.canManageMailboxes,
		...(isPrimaryAdmin(auth.user) && parsed.data.canManageDomains !== undefined ? { canManageDomains: parsed.data.canManageDomains } : {}),
		...(isPrimaryAdmin(auth.user) && parsed.data.canManageUsers !== undefined ? { canManageUsers: parsed.data.canManageUsers } : {}),
		...(parsed.data.forwardingEmail !== undefined ? { forwardingEmail: parsed.data.forwardingEmail } : {}),
	}).where(eq(users.id, id));
	return NextResponse.json({ ok: true });
}
