import { and, eq } from "drizzle-orm";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { bookingEvents, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { parseBookingEventInput } from "@/lib/booking/utils";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { ensureBookingUsername } from "@/lib/booking/username";
import { validBookingHostIds } from "@/lib/booking/hosts";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { calendarAccessError } from "@/lib/calendar/api-auth";
import { ConfirmationTemplatesUnavailableError, saveConfirmationTemplate, withConfirmationTemplates } from "@/lib/booking/confirmation-templates";
import { parseConfirmationTemplateInput } from "@/lib/booking/confirmation-utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const denied = calendarAccessError(user);
	if (denied) return denied;
	const username = await ensureBookingUsername(env, user.id, user.email);
	const db = getDb(env);
	const events = await withConfirmationTemplates(db, await db.select().from(bookingEvents).where(eq(bookingEvents.userId, user.id)).orderBy(bookingEvents.createdAt));
	const [currentUser] = await db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, user.id)).limit(1);
	const canManageHosts = user.role === "admin" && (await getLicenseEntitlements(env)).canShareMailboxes;
	return NextResponse.json({ events, username, currentUser: { id: user.id, name: user.name, email: user.email, hasAvatar: !!currentUser?.avatarKey }, canManageHosts });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const denied = calendarAccessError(user);
	if (denied) return denied;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const body = await request.json().catch(() => null);
	const input = parseBookingEventInput(body);
	const confirmation = parseConfirmationTemplateInput(body);
	if (!input) return NextResponse.json({ error: "Enter valid booking details and availability." }, { status: 400 });
	if (confirmation === null) return NextResponse.json({ error: "Check the confirmation email's subject and message." }, { status: 400 });
	const db = getDb(env);
	const canManageHosts = user.role === "admin" && (await getLicenseEntitlements(env)).canShareMailboxes;
	const hostIds = await validBookingHostIds(db, user.id, input.hostIds, canManageHosts);
	if (!hostIds) return NextResponse.json({ error: "Choose users from the host list." }, { status: 400 });
	const [taken] = await db.select({ id: bookingEvents.id }).from(bookingEvents).where(and(eq(bookingEvents.userId, user.id), eq(bookingEvents.slug, input.slug))).limit(1);
	if (taken) return NextResponse.json({ error: "This event link is already in use." }, { status: 409 });
	try {
		const [event] = await db.insert(bookingEvents).values({ ...input, id: newId("book"), userId: user.id, hostIds: JSON.stringify(hostIds), weekdays: JSON.stringify(input.weekdays), timeRanges: JSON.stringify(input.timeRanges) }).returning();
		if (confirmation) {
			try {
				await saveConfirmationTemplate(db, event.id, confirmation);
			} catch (error) {
				// Create the event with its confirmation or not at all, so a retry does not hit "link already in use".
				await db.delete(bookingEvents).where(eq(bookingEvents.id, event.id));
				if (error instanceof ConfirmationTemplatesUnavailableError) return NextResponse.json({ error: error.message }, { status: 409 });
				throw error;
			}
		}
		const [saved] = await withConfirmationTemplates(db, [event]);
		return NextResponse.json({ event: saved });
	} catch (error) {
		if (isUniqueConstraintError(error)) return NextResponse.json({ error: "This event link is already in use." }, { status: 409 });
		throw error;
	}
}
