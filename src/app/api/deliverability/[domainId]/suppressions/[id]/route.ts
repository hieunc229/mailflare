import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { confirmSuppression, removeSuppression } from "@/lib/deliverability/suppression-admin";

type Params = { params: Promise<{ domainId: string; id: string }> };

/** Removes an address from the domain's suppression list, so the next send to it is attempted again. */
export async function DELETE(request: Request, { params }: Params) {
	const { domainId, id } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, true);
	if (access.error) return access.error;
	const removed = await removeSuppression(env, domainId, id);
	if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
	await createAuditLog(env, { actorUserId: access.user.id, action: "deliverability.suppression_removed", metadata: { domain: access.domain.hostname, email: removed.email } });
	return NextResponse.json({ removed: true });
}

/** Confirms an unconfirmed entry (one a single returned message reported), so sending to it is refused from now on. */
export async function PATCH(request: Request, { params }: Params) {
	const { domainId, id } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, true);
	if (access.error) return access.error;
	const confirmed = await confirmSuppression(env, domainId, id);
	if (!confirmed) return NextResponse.json({ error: "Not found" }, { status: 404 });
	await createAuditLog(env, { actorUserId: access.user.id, action: "deliverability.suppression_confirmed", metadata: { domain: access.domain.hostname, email: confirmed.email } });
	return NextResponse.json({ confirmed: true });
}
