import { NextResponse } from "next/server";
import type { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { loadPromotionModes } from "@/lib/promotions/settings";

type Db = ReturnType<typeof getDb>;

export const MIGRATION_REQUIRED = { error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" };
export const isMissingSchema = (error: unknown) => isMissingTableError(error) || isMissingColumnError(error);

/** Session user plus the same-origin check every promotions mutation needs. */
export async function authorizeMutation(env: CloudflareEnv, request: Request) {
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth;
	if (!hasValidSessionMutationOrigin(request)) return { user: null, error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) } as const;
	return auth;
}

/** Full access to the mailbox, and Promotions turned on for it (off means the feature is invisible there). Returns the error response, or null. */
export async function checkManagedMailbox(db: Db, user: Parameters<typeof getMailboxAccessLevel>[1], mailboxId: string): Promise<NextResponse | null> {
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	if (!access.canManage) return NextResponse.json({ error: "You cannot change this mailbox" }, { status: 403 });
	if (((await loadPromotionModes(db, [mailboxId])).get(mailboxId) ?? "off") === "off") {
		return NextResponse.json({ error: "Promotions is off for this mailbox", code: "PROMOTIONS_OFF" }, { status: 409 });
	}
	return null;
}
