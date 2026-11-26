import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { isMissingColumnError } from "@/lib/database-errors";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { createAuditLog } from "@/lib/mailboxes/audit";

const NO_STORE = { "Cache-Control": "no-store" };

/** The stored switch, false when the database has not run the migration yet. */
async function readSwitch(env: CloudflareEnv): Promise<boolean> {
	try {
		const [row] = await getDb(env).select({ on: appSettings.calendarOrgFreeBusy }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
		return !!row?.on;
	} catch (error) {
		if (!isMissingColumnError(error)) throw error;
		return false;
	}
}

/** `available` is the Team licence (D-13): the administrator page shows the switch only then. `enabled` is the stored switch. */
async function state(env: CloudflareEnv) {
	return { available: (await getLicenseEntitlements(env)).canShareMailboxes, enabled: await readSwitch(env) };
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	return Response.json(await state(env), { headers: NO_STORE });
}

/** Organisation-wide free/busy (D-10, D-13): Team only to turn on, always possible to turn off, every change audited. */
export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body: unknown = await request.json().catch(() => null);
	const enabled = body && typeof body === "object" ? (body as { enabled?: unknown }).enabled : undefined;
	if (typeof enabled !== "boolean") return Response.json({ error: "Send enabled as true or false" }, { status: 400 });
	const current = await state(env);
	if (enabled && !current.available) return Response.json({ error: "Organisation-wide free/busy needs a Team licence" }, { status: 403 });
	if (enabled === current.enabled) return Response.json(current, { headers: NO_STORE });
	try {
		const values = { calendarOrgFreeBusy: enabled, updatedAt: new Date() };
		await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
	} catch (error) {
		if (!isMissingColumnError(error)) throw error;
		return Response.json({ error: "Apply pending database migrations first." }, { status: 500 });
	}
	await createAuditLog(env, { actorUserId: auth.user.id, action: "calendar.org_free_busy_changed", metadata: { enabled } });
	return Response.json({ ...current, enabled }, { headers: NO_STORE });
}
