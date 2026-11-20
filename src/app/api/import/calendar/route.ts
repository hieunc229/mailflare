import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { importCalendarGroups, listOwnAddresses } from "@/lib/calendar/import-store";
import { readCalendarImportBody } from "@/lib/calendar/import-store-utils";
import { recipientInviteTimeZone } from "@/lib/calendar/invite-store";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { getRequestTimeZone } from "@/lib/time/utils";

/** The Takeout importer batches by 256 Ki characters (not bytes) per request; the hard limit is 1 MiB of bytes. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Imports the events of one Google Calendar .ics file, a few UIDs at a time. Safe to repeat: see importCalendarGroups. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, key, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	if (!key && !hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let body: unknown;
	try {
		body = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
	} catch (caught) {
		return caught instanceof RequestBodyTooLargeError
			? NextResponse.json({ error: "Request body is too large" }, { status: 413 })
			: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const input = readCalendarImportBody(body);
	if (!input.value) return NextResponse.json({ error: input.error }, { status: 400 });
	const db = getDb(env);
	try {
		const summary = await importCalendarGroups(db, {
			userId: user.id,
			// The account's zone, else the zone of the user's own events, else the browser's.
			userZone: (await recipientInviteTimeZone(db, user.id)) ?? getRequestTimeZone(request),
			ownAddresses: await listOwnAddresses(db, user.id, user.email, input.value.googleAddress),
			color: normalizeCalendarColor(input.value.color),
			reminders: input.value.reminders,
			skipDeclined: input.value.skipDeclined,
			groups: input.value.groups,
		});
		return NextResponse.json(summary);
	} catch (caught) {
		if (caught instanceof RequestBodyTooLargeError) return NextResponse.json({ error: caught.message }, { status: 413 });
		throw caught;
	}
}
