import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { bookingEvents, users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";

export async function GET(request: Request) {
	const url = new URL(request.url);
	const username = url.searchParams.get("username");
	const userId = url.searchParams.get("userId");
	if (!username && !userId) return NextResponse.json({ error: "Missing booking page" }, { status: 400 });
	const db = getDb(getEnv());
	const [user] = await db.select({ id: users.id, name: users.name, username: users.bookingUsername }).from(users).where(and(username ? eq(users.bookingUsername, username.toLowerCase()) : eq(users.id, userId!), eq(users.disabled, false), eq(users.calendarEnabled, true))).limit(1);
	if (!user) return NextResponse.json({ error: "Booking page not found" }, { status: 404 });
	const events = await db.select({ id: bookingEvents.id, slug: bookingEvents.slug, name: bookingEvents.name, description: bookingEvents.description, durationMinutes: bookingEvents.durationMinutes, location: bookingEvents.location, weekdays: bookingEvents.weekdays, timeZone: bookingEvents.timeZone }).from(bookingEvents).where(and(eq(bookingEvents.userId, user.id), eq(bookingEvents.enabled, true))).orderBy(bookingEvents.createdAt);
	return NextResponse.json({ name: user.name, username: user.username, events });
}
