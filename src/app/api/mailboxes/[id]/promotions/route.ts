import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { mailboxPromotionSettings } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { backfillPatchForModeChange, describeBackfill, parseModeBody } from "@/lib/promotions/mode-utils";

type Params = { params: Promise<{ id: string }> };

const MIGRATION_REQUIRED = { error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" };
const isMissingSchema = (error: unknown) => isMissingTableError(error) || isMissingColumnError(error);

async function readSettings(db: ReturnType<typeof getDb>, mailboxId: string) {
	const [row] = await db.select().from(mailboxPromotionSettings).where(eq(mailboxPromotionSettings.mailboxId, mailboxId)).limit(1);
	return row ?? null;
}

export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, auth.user, id);
	if (!access?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	try {
		const row = await readSettings(db, id);
		return NextResponse.json({ mode: row?.mode ?? "off", backfill: describeBackfill(row) });
	} catch (error) {
		// Before the migration every mailbox is off.
		if (isMissingSchema(error)) return NextResponse.json({ mode: "off", backfill: describeBackfill(null) });
		throw error;
	}
}

/** Sets the mailbox's Promotions mode; the first move away from off queues the backfill. */
export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, auth.user, id);
	if (!access?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	if (!access.canManage) return NextResponse.json({ error: "You cannot change this mailbox" }, { status: 403 });
	const parsed = parseModeBody(await request.json().catch(() => null));
	if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

	try {
		const current = await readSettings(db, id);
		const patch = backfillPatchForModeChange(current, parsed.mode);
		// `updated_at` fences a running backfill and dates its takeover, so show <-> separate (no backfill change) leaves it alone.
		const keepsRun = !!current && current.mode !== "off" && parsed.mode !== "off" && Object.keys(patch).length === 0;
		const values = { mode: parsed.mode, ...patch, ...(keepsRun ? {} : { updatedAt: new Date() }) };
		await db.insert(mailboxPromotionSettings)
			.values({ mailboxId: id, ...values })
			.onConflictDoUpdate({ target: mailboxPromotionSettings.mailboxId, set: values });
		const row = await readSettings(db, id);
		return NextResponse.json({ mode: parsed.mode, backfill: describeBackfill(row) });
	} catch (error) {
		if (isMissingSchema(error)) return NextResponse.json(MIGRATION_REQUIRED, { status: 409 });
		throw error;
	}
}
