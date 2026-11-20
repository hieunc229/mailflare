import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { acknowledgeAlert } from "@/lib/deliverability/alerts";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { migrationRequired } from "@/lib/deliverability/route-utils";

type Params = { params: Promise<{ domainId: string; alertId: string }> };

/** Acknowledges one alert of the domain. */
export async function PATCH(request: Request, { params }: Params) {
	const { domainId, alertId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, true);
	if (access.error) return access.error;
	try {
		if (!await acknowledgeAlert(env, domainId, alertId, access.user.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
		return NextResponse.json({ ok: true });
	} catch (error) {
		return migrationRequired(error);
	}
}
