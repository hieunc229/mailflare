import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { domainListOwnerIds } from "@/lib/domains/utils";
import { listUserDomains } from "@/lib/domains/service";

/** Session, domain-admin permission, origin check on writes, and a domain this admin may manage. */
export async function authorizeDomainAdmin(env: CloudflareEnv, request: Request, domainId: string, write: boolean) {
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { error: auth.error };
	if (!canManageDomains(auth.user)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	if (write && !hasValidSessionMutationOrigin(request)) return { error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) };
	const domain = (await listUserDomains(env, domainListOwnerIds(auth.user))).find((candidate) => candidate.id === domainId);
	if (!domain) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
	return { user: auth.user, domain };
}
