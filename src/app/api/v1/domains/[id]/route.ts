import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { getDomainForUser, removeDomainForUser } from "@/lib/domains/service";
import { mtaStsBlockedResponse } from "@/lib/deliverability/mta-sts-block-response";

type Params = { params: Promise<{ id: string }> };

async function authorize(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "domains");
	if (!auth) return null;
	return auth;
}

export async function GET(request: Request, { params }: Params) {
	const auth = await authorize(request);
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const { id } = await params;
	const domain = await getDomainForUser(getEnv(), auth.userId, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json({ domain });
}

export async function DELETE(request: Request, { params }: Params) {
	const auth = await authorize(request);
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const { id } = await params;
	try {
		// `{ force: true, confirm: "<host name>" }` skips the MTA-STS checks; the answer lists the DNS records left to remove by hand.
		const body = (await request.json().catch(() => null)) as { force?: unknown; confirm?: unknown } | null;
		const force = body?.force === true ? { confirm: body.confirm } : undefined;
		const result = await removeDomainForUser(getEnv(), auth.userId, id, force);
		return NextResponse.json(force ? { ok: true, ...result } : { ok: true });
	} catch (err) {
		const blocked = await mtaStsBlockedResponse(err);
		if (blocked) return blocked;
		const message = err instanceof Error ? err.message : "Failed to remove domain";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
