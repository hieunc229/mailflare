import { NextResponse } from "next/server";
import { availableBookingSlots } from "@/lib/booking/availability";
import { getEnv } from "@/lib/cloudflare";
import { createBookedCalendarEvents } from "@/lib/booking/create";
import { sendBookingConfirmation } from "@/lib/booking/confirmation";
import { allowBookingAttempt } from "@/lib/auth/rate-limit";
import { pickGuestLocale } from "@/lib/booking/confirmation-utils";
import type { PublicBookingRouteContext, PublicBookingSubmission } from "./types";
import { loadPublicBookingEvent, parseBookingGuestEmails } from "./utils";

export async function GET(request: Request, { params }: PublicBookingRouteContext) {
	const { eventId } = await params;
	const found = await loadPublicBookingEvent(eventId, new URL(request.url).searchParams.get("username"));
	if (!found) return NextResponse.json({ error: "Booking event not found" }, { status: 404 });
	const slots = await availableBookingSlots(getEnv(), found.event, 60);
	return NextResponse.json({ event: found.event, hostName: found.hostName, slots });
}

export async function POST(request: Request, { params }: PublicBookingRouteContext) {
	if (!(await allowBookingAttempt(getEnv(), request))) return NextResponse.json({ error: "Too many booking attempts. Try again in a minute." }, { status: 429 });
	const { eventId } = await params;
	const found = await loadPublicBookingEvent(eventId, new URL(request.url).searchParams.get("username"));
	if (!found) return NextResponse.json({ error: "Booking event not found" }, { status: 404 });
	const body = await request.json().catch(() => null) as PublicBookingSubmission | null;
	const name = typeof body?.name === "string" ? body.name.trim() : "";
	const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
	if (!name || name.length > 120 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || typeof body?.startsAt !== "string") return NextResponse.json({ error: "Enter your name, email, and a time." }, { status: 400 });
	const guestEmails = parseBookingGuestEmails(body?.guestEmails, email);
	const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
	if (!guestEmails || notes.length > 2000 || (body?.notes !== undefined && typeof body.notes !== "string")) return NextResponse.json({ error: "Check the guest emails and meeting notes." }, { status: 400 });
	const slots = await availableBookingSlots(getEnv(), found.event, 60);
	const slot = slots.find((item) => item.startsAt === body.startsAt);
	if (!slot) return NextResponse.json({ error: "That time is no longer available." }, { status: 409 });
	if (!(await createBookedCalendarEvents(getEnv(), found.event, name, email, slot.startsAt, slot.endsAt, guestEmails, notes))) return NextResponse.json({ error: "That time is no longer available." }, { status: 409 });
	const locale = pickGuestLocale(/(?:^|;\s*)mailflare-locale=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1], request.headers.get("accept-language"));
	await sendBookingConfirmation(getEnv(), { event: found.event, hostName: found.hostName, guestName: name, guestEmail: email, notes, startsAt: slot.startsAt, endsAt: slot.endsAt, locale, publicOrigin: new URL(request.url).origin });
	return NextResponse.json({ booked: true, startsAt: slot.startsAt, endsAt: slot.endsAt });
}
