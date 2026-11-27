import { getEnv } from "@/lib/cloudflare";
import { hashApiKey } from "@/lib/api-keys";
import { authenticateFreeBusyKey } from "@/lib/calendar/free-busy-link";
import { buildFreeBusyIcs, buildFreeBusyIfb, publishedBusy, publishWindow } from "@/lib/calendar/free-busy-publish";

/**
 * A person's busy times at a secret URL (spec F9 D-11), for people and calendar apps that cannot sign in: `.ifb` (default) or
 * `format=ics`. Public: the key in the query is the only credential, and only a key whose scope is exactly `calendar:freebusy` opens it.
 * Every refusal is the same answer, so it says nothing about which accounts exist. No title, place, guest or UID of an event is ever in the body.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const url = new URL(request.url);
	const owner = await authenticateFreeBusyKey(env, url.searchParams.get("key") ?? "");
	if (!owner) return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
	const format = url.searchParams.get("format") ?? "ifb";
	if (format !== "ifb" && format !== "ics") return new Response("Unknown format", { status: 400, headers: { "Cache-Control": "no-store" } });
	const now = new Date();
	const intervals = await publishedBusy(env, owner.userId, now);
	// A UID that is stable for this link but says nothing about the key or the account.
	const uid = (await hashApiKey(`freebusy:${owner.keyId}`)).slice(0, 32);
	const body = format === "ics" ? buildFreeBusyIcs(intervals, { uid, now }) : buildFreeBusyIfb(intervals, { uid, now, ...publishWindow(now) });
	return new Response(body, { headers: {
		"Content-Type": "text/calendar; charset=utf-8",
		"Content-Disposition": `inline; filename="freebusy.${format}"`,
		// The server checks the key on every request, so a revoked link stops at once; this only lets one client reuse its copy briefly.
		"Cache-Control": "private, max-age=300",
		"X-Robots-Tag": "noindex",
	} });
}
