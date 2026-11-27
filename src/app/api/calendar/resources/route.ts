import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { listResources } from "@/lib/calendar/resources";
import { getLicenseEntitlements } from "@/lib/licenses/service";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The rooms and equipment anyone with Calendar may pick (spec F9 8.4): the enabled ones, with what a booker needs and none of the
 * administrator's notes. `canBook` is the Team licence (D-13): without it rooms can be seen and kept but not newly booked.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const { error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const resources = (await listResources(getDb(env), { includeDisabled: false })).map(({ id, name, kind, capacity, location }) => ({ id, name, kind, capacity, location }));
	return NextResponse.json({ resources, canBook: (await getLicenseEntitlements(env)).canShareMailboxes }, { headers: NO_STORE });
}
