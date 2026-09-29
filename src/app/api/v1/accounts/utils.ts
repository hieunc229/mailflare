import { NextResponse } from "next/server";
import { eq, or } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticateAdminApiKey, canManageAdminAccounts } from "@/lib/api/admin-auth";
import { createUserAccountSchema } from "@/lib/validators";
import { accountListItemFromUser } from "@/app/api/accounts/utils";
import { createAccountResponse } from "@/app/api/accounts/create";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!(await canManageAdminAccounts(env))) return NextResponse.json({ error: "A Team license is required to manage accounts" }, { status: 403 });
	const rows = await getDb(env).select().from(users).where(or(eq(users.id, auth.userId), eq(users.createdByUserId, auth.userId)));
	return NextResponse.json({ accounts: rows.map(accountListItemFromUser) });
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!(await canManageAdminAccounts(env))) return NextResponse.json({ error: "A Team license is required to manage accounts" }, { status: 403 });
	const parsed = createUserAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	return createAccountResponse(env, auth.userId, parsed.data);
}
