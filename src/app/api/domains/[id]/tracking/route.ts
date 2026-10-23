import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getDomainForUser } from "@/lib/domains/service";
import { getDomainTrackingHost, setDomainTrackingHost, TrackingHostsUnavailableError } from "@/lib/tracking/open-tracking";
import { normalizeTrackingHost } from "@/lib/tracking/open-tracking-utils";
import { isUniqueConstraintError } from "@/lib/database-errors";

type Params = { params: Promise<{ id: string }> };

const MIGRATION_REQUIRED = { error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" };

export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!canManageDomains(auth.user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	const domain = await getDomainForUser(env, auth.user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	try {
		return NextResponse.json({ hostname: await getDomainTrackingHost(env, id), available: true });
	} catch (error) {
		if (error instanceof TrackingHostsUnavailableError) return NextResponse.json({ hostname: null, available: false });
		throw error;
	}
}

/** Sets (or clears, with an empty hostname) the host that serves this domain's read-receipt pixels. */
export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!canManageDomains(auth.user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const domain = await getDomainForUser(env, auth.user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });

	const body = (await request.json().catch(() => null)) as { hostname?: unknown } | null;
	if (body?.hostname !== null && typeof body?.hostname !== "string") {
		return NextResponse.json({ error: "hostname must be a string or null" }, { status: 400 });
	}
	let hostname: string | null = null;
	if (body.hostname?.trim()) {
		const normalized = normalizeTrackingHost(body.hostname, domain.hostname);
		if ("error" in normalized) {
			return NextResponse.json({ error: normalized.error === "outsideDomain" ? `Use ${domain.hostname} or one of its subdomains` : "Enter a valid hostname", code: normalized.error }, { status: 400 });
		}
		hostname = normalized.hostname;
	}
	try {
		await setDomainTrackingHost(env, id, hostname);
	} catch (error) {
		if (error instanceof TrackingHostsUnavailableError) return NextResponse.json(MIGRATION_REQUIRED, { status: 409 });
		if (isUniqueConstraintError(error)) return NextResponse.json({ error: "Another domain already uses this hostname" }, { status: 409 });
		throw error;
	}
	return NextResponse.json({ hostname, available: true });
}
