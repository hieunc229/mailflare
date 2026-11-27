import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { disableFreeBusyLink, enableFreeBusyLink, getFreeBusyLink } from "@/lib/calendar/free-busy-link";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { createAuditLog } from "@/lib/mailboxes/audit";

/** An API key must not be able to mint (or read, or cut) a public link to the account's schedule: the publish link is managed from a signed-in session only (F9 D-11, as the CS-3 shares). */
const sessionOnly = () => NextResponse.json({ error: "The free/busy link can only be changed from a signed-in session" }, { status: 403 });
const NO_STORE = { "Cache-Control": "no-store" };

async function session(request: Request, scope: "calendar:read" | "calendar:write") {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, scope);
	if (error) return { env, user: null, error };
	if (key) return { env, user: null, error: sessionOnly() };
	if (scope === "calendar:write" && !hasValidSessionMutationOrigin(request)) return { env, user: null, error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, user, error: null };
}

/** Whether the link is on. The secret is stored only as a hash, so it is never returned here: it is shown once, when the link is created. */
export async function GET(request: Request) {
	const { env, user, error } = await session(request, "calendar:read");
	if (error) return error;
	const link = await getFreeBusyLink(getDb(env), user.id);
	return NextResponse.json(link.enabled ? { enabled: true, createdAt: link.createdAt.toISOString(), lastUsedAt: link.lastUsedAt?.toISOString() ?? null } : { enabled: false }, { headers: NO_STORE });
}

/** Turns the link on. Already on: nothing changes and no secret is returned (`created: false`). */
export async function POST(request: Request) {
	const { env, user, error } = await session(request, "calendar:write");
	if (error) return error;
	const result = await enableFreeBusyLink(getDb(env), user.id);
	if (result.created) await createAuditLog(env, { actorUserId: user.id, targetUserId: user.id, action: "calendar.freebusy_published" });
	return NextResponse.json({ enabled: true, ...result }, { headers: NO_STORE });
}

/** Turns the link off by deleting its key: the URL stops working at once. */
export async function DELETE(request: Request) {
	const { env, user, error } = await session(request, "calendar:write");
	if (error) return error;
	if (await disableFreeBusyLink(getDb(env), user.id)) await createAuditLog(env, { actorUserId: user.id, targetUserId: user.id, action: "calendar.freebusy_unpublished" });
	return NextResponse.json({ enabled: false }, { headers: NO_STORE });
}
