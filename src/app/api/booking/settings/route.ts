import { eq } from "drizzle-orm";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { normalizeBookingUsername } from "@/lib/booking/utils";
import { getEnv } from "@/lib/cloudflare";
import { calendarAccessError } from "@/lib/calendar/api-auth";
import type { BookingSettingsInput } from "./types";

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const denied = calendarAccessError(user);
	if (denied) return denied;
	if (user.role !== "admin") return NextResponse.json({ error: "Only administrators can change booking usernames." }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const body = await request.json().catch(() => null) as BookingSettingsInput | null;
	const username = normalizeBookingUsername(body?.username);
	if (!username) return NextResponse.json({ error: "Use up to 64 lowercase letters, numbers, dots, underscores, plus signs, or hyphens." }, { status: 400 });
	const db = getDb(env);
	const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.bookingUsername, username)).limit(1);
	if (taken && taken.id !== user.id) return NextResponse.json({ error: "This username is already taken." }, { status: 409 });
	try {
		await db.update(users).set({ bookingUsername: username }).where(eq(users.id, user.id));
		return NextResponse.json({ username });
	} catch (error) {
		if (isUniqueConstraintError(error)) return NextResponse.json({ error: "This username is already taken." }, { status: 409 });
		throw error;
	}
}
