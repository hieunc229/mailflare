import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { adminApiKeyRevocations } from "@/lib/api/admin-key-revocation";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { requireTeamAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";
import { selectAccountById } from "../utils";

export async function POST(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const actor = access.user!;
	if (!isPrimaryAdmin(actor)) {
		return NextResponse.json({ error: "Only the primary admin can transfer the role" }, { status: 403 });
	}
	if (!hasValidSessionMutationOrigin(request)) {
		return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	}
	const { id } = await params;
	const db = getDb(access.env);
	const target = await selectAccountById(db, id);
	if (!target) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	if (target.id === actor.id) {
		return NextResponse.json({ error: "You are already the primary admin" }, { status: 400 });
	}
	if (target.disabled) {
		return NextResponse.json({ error: "Enable this account before transferring the primary admin role" }, { status: 400 });
	}
	// One atomic switch: the old owner steps down exactly as the new one steps up, and the admin API
	// keys they minted as primary admin stop working with the role.
	const revocations = await adminApiKeyRevocations(db, actor.id);
	await db.batch([
		db.update(users).set({ isPrimaryAdmin: false }).where(eq(users.id, actor.id)),
		db.update(users).set({ isPrimaryAdmin: true, role: "admin" }).where(eq(users.id, target.id)),
		...revocations,
	]);
	return NextResponse.json({ ok: true });
}
