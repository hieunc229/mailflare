import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { createUserAccountSchema } from "@/lib/validators";
import { createAccountResponse } from "./create";
import { accountListItemFromUser, listAccountsForAdmin, requireTeamAdmin } from "./utils";

export async function GET(request: Request) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const rows = await listAccountsForAdmin(getDb(access.env));
	return NextResponse.json({
		accounts: rows.map((row) => accountListItemFromUser(row)),
	});
}

export async function POST(request: Request) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const parsed = createUserAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}
	return createAccountResponse(access.env, access.user!.id, parsed.data);
}
