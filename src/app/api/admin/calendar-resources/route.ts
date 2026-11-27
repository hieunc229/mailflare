import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { createResource, deleteResource, listResources, updateResource } from "@/lib/calendar/resources";
import type { ResourceFailure } from "@/lib/calendar/resources-types";
import { readJsonObject } from "@/lib/http/request";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { createAuditLog } from "@/lib/mailboxes/audit";

const NO_STORE = { "Cache-Control": "no-store" };

/** The signed-in primary administrator (as for the other installation-wide calendar setting), or the response that refuses. */
async function authorize(env: CloudflareEnv, request: Request, write: boolean) {
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { response: auth.error };
	if (!isPrimaryAdmin(auth.user)) return { response: Response.json({ error: "Forbidden" }, { status: 403 }) };
	if (write && !hasValidSessionMutationOrigin(request)) return { response: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	return { user: auth.user };
}

const refuse = (failure: ResourceFailure & { bookings?: number }) => Response.json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}), ...(failure.bookings !== undefined ? { bookings: failure.bookings } : {}) }, { status: failure.status, headers: NO_STORE });

/** Every room and resource, disabled ones included. `available` is the Team licence (D-13): without it the list is still readable, new rooms cannot be made. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authorize(env, request, false);
	if (auth.response) return auth.response;
	return Response.json({ resources: await listResources(getDb(env), { includeDisabled: true }), available: (await getLicenseEntitlements(env)).canShareMailboxes }, { headers: NO_STORE });
}

/** Create a room or resource (spec F9 8.4). Team only; audited as `calendar.resource_created`. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authorize(env, request, true);
	if (auth.response) return auth.response;
	const body = await readJsonObject(request);
	if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
	if (!(await getLicenseEntitlements(env)).canShareMailboxes) return Response.json({ error: "Rooms need a Team licence", code: "TEAM_REQUIRED" }, { status: 403, headers: NO_STORE });
	const result = await createResource(getDb(env), auth.user.id, body);
	if (!result.ok) return refuse(result);
	await createAuditLog(env, { actorUserId: auth.user.id, action: "calendar.resource_created", metadata: { resourceId: result.resource.id, name: result.resource.name } });
	return Response.json({ resource: result.resource }, { status: 201, headers: NO_STORE });
}

/** Edit or turn off a room. Allowed after a licence lapses: turning rooms off is how an administrator tidies up. */
export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await authorize(env, request, true);
	if (auth.response) return auth.response;
	const body = await readJsonObject(request);
	if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
	const result = await updateResource(getDb(env), body);
	if (!result.ok) return refuse(result);
	const changed = ["name", "kind", "capacity", "location", "description", "disabled"].filter((key) => Object.prototype.hasOwnProperty.call(body, key));
	await createAuditLog(env, { actorUserId: auth.user.id, action: "calendar.resource_updated", metadata: { resourceId: result.resource.id, name: result.resource.name, changed } });
	return Response.json({ resource: result.resource }, { headers: NO_STORE });
}

/** Delete a room: refused (409 `HAS_BOOKINGS`) while events still have it booked ahead, unless `force`, which drops those bookings and names the events. */
export async function DELETE(request: Request) {
	const env = getEnv();
	const auth = await authorize(env, request, true);
	if (auth.response) return auth.response;
	const body = await readJsonObject(request);
	if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
	const force = body.force === true;
	const result = await deleteResource(getDb(env), body.id, force);
	if (!result.ok) return refuse(result);
	await createAuditLog(env, { actorUserId: auth.user.id, action: "calendar.resource_deleted", metadata: { resourceId: body.id as string, name: result.name, force, eventIds: result.eventIds, bookings: result.bookings } });
	return Response.json({ ok: true, eventIds: result.eventIds }, { headers: NO_STORE });
}
