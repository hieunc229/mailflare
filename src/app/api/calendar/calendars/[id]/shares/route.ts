import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { calendarIdFrom } from "@/lib/calendar/calendar-id";
import { changeShare, grantShare, listShares, revokeShare } from "@/lib/calendar/shares";
import { readJsonObject } from "@/lib/http/request";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { CalendarRouteParams } from "../types";

/** A write-scope key must not be able to turn itself into a permanent read grant for someone else: sharing is changed from a session only (like the publish link, F9 D-11). */
const sessionOnly = () => NextResponse.json({ error: "Sharing can only be changed from a signed-in session" }, { status: 403 });
const refuse = (result: { status: number; error: string; code?: string }) => NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });

export async function GET(request: Request, { params }: CalendarRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const result = await listShares(getDb(env), user, calendarIdFrom((await params).id));
	return result.ok ? NextResponse.json({ shares: result.shares }) : refuse(result);
}

export async function POST(request: Request, { params }: CalendarRouteParams) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	if (key) return sessionOnly();
	const input = await readJsonObject<{ email?: unknown; role?: unknown }>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const calendarId = calendarIdFrom((await params).id);
	const result = await grantShare(getDb(env), user, calendarId, input);
	if (!result.ok) return refuse(result);
	await createAuditLog(env, { actorUserId: user.id, targetUserId: result.ownerId, action: "calendar.share_granted", metadata: { calendarId, shareId: result.share.id, granteeUserId: result.share.userId, role: result.share.role } });
	return NextResponse.json({ share: result.share });
}

export async function PATCH(request: Request, { params }: CalendarRouteParams) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	if (key) return sessionOnly();
	const input = await readJsonObject<{ id?: unknown; role?: unknown }>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const calendarId = calendarIdFrom((await params).id);
	const result = await changeShare(getDb(env), user, calendarId, input);
	if (!result.ok) return refuse(result);
	if (result.previousRole !== result.share.role) {
		await createAuditLog(env, { actorUserId: user.id, targetUserId: result.ownerId, action: "calendar.share_changed", metadata: { calendarId, shareId: result.share.id, granteeUserId: result.share.userId, previousRole: result.previousRole, role: result.share.role } });
	}
	return NextResponse.json({ share: result.share });
}

/** The grant to remove is `id` in the JSON body or `shareId` in the query. */
export async function DELETE(request: Request, { params }: CalendarRouteParams) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	if (key) return sessionOnly();
	const input = await request.json().catch(() => null) as { id?: unknown } | null;
	const shareId = typeof input?.id === "string" ? input.id : new URL(request.url).searchParams.get("shareId");
	const calendarId = calendarIdFrom((await params).id);
	const result = await revokeShare(getDb(env), user, calendarId, shareId);
	if (!result.ok) return refuse(result);
	await createAuditLog(env, { actorUserId: user.id, targetUserId: result.ownerId, action: "calendar.share_revoked", metadata: { calendarId, shareId: result.share.id, granteeUserId: result.share.userId, role: result.share.role } });
	return NextResponse.json({ ok: true, self: result.share.userId === user.id });
}
