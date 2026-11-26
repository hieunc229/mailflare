import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { busyIntervals, type BusyInterval } from "@/lib/calendar/free-busy";
import { resolveFreeBusyAddresses, viewableFreeBusyUsers } from "@/lib/calendar/free-busy-access";
import { parseFreeBusyRequest } from "@/lib/calendar/free-busy-request";
import { readJsonObject } from "@/lib/http/request";

const NO_STORE = { "Cache-Control": "no-store" };
const iso = ([from, to]: BusyInterval) => [new Date(from).toISOString(), new Date(to).toISOString()];

/**
 * Busy times of the people named by address (spec F9 8.4, D-10). Whoever the caller may not see, whoever has no account, and any
 * outside address all get the same `{ status: "unknown" }`, so the answer says nothing about who has an account here.
 * `resourceIds` (rooms, CS-7) is accepted and ignored until rooms exist: no key is answered for them.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const body = await readJsonObject(request);
	const parsed = body ? parseFreeBusyRequest(body) : "Invalid JSON body";
	if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400, headers: NO_STORE });
	const accounts = await resolveFreeBusyAddresses(env, parsed.addresses);
	const visible = await viewableFreeBusyUsers(env, user.id, [...new Set(accounts.values())]);
	const busy = visible.size ? await busyIntervals(env, { userIds: [...visible] }, parsed.start, parsed.end) : new Map<string, BusyInterval[]>();
	const results: Record<string, { status: "ok"; busy: string[][] } | { status: "unknown" }> = {};
	for (const address of parsed.addresses) {
		const id = accounts.get(address);
		results[address] = id && visible.has(id) ? { status: "ok", busy: (busy.get(id) ?? []).map(iso) } : { status: "unknown" };
	}
	return NextResponse.json({ results }, { headers: NO_STORE });
}
