import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getDomainForUser } from "@/lib/domains/service";
import { ensureSmtp2goDomain, getDomainRecords } from "@/lib/tenancy/smtp2go";

type Params = { params: Promise<{ id: string }> };

/** Hosted workspaces: the DNS records SMTP2GO lists for a domain (sending and receiving together). */
async function respond(request: Request, { params }: Params, verify: boolean) {
	const { id } = await params;
	const env = getEnv();
	if (!env.MAILFLARE_TENANT) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	if (verify && (!canManageDomains(user) || !hasValidSessionMutationOrigin(request))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	try {
		// Connected on first view, so the records show without an extra step.
		if (domain.sendingProvider !== "smtp2go" && canManageDomains(user)) await ensureSmtp2goDomain(env, domain);
		const records = await getDomainRecords(env, domain, verify);
		if (records.registered && records.sendingVerified) {
			// Tells the control plane this workspace is really in use (see the unused-trial cleanup in the cloud's tenant Worker).
			await env.CONTROL?.prepare("UPDATE workspaces SET domain_verified_at = ? WHERE id = ? AND domain_verified_at IS NULL")
				.bind(Math.floor(Date.now() / 1000), env.MAILFLARE_TENANT.id).run();
		}
		if (records.registered) {
			// The operator console shows how many required records the workspace's own domain still misses. Never fails the check.
			const required = records.records.filter((record) => !record.optional);
			await env.CONTROL?.prepare("UPDATE workspaces SET dns_done = ?, dns_total = ?, dns_checked_at = ? WHERE id = ? AND lower(domain) = lower(?)")
				.bind(required.filter((record) => record.status === "verified").length, required.length, Math.floor(Date.now() / 1000), env.MAILFLARE_TENANT.id, domain.hostname).run()
				.catch((error) => console.error("dns counts not saved", error));
		}
		// Provider fully verified the domain: the "DNS isn't configured" warning no longer applies.
		if (domain.dnsSkipped && records.registered && records.status === "verified") {
			await getDb(env).update(domains).set({ dnsSkipped: false }).where(eq(domains.id, domain.id));
		}
		return NextResponse.json(records, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Could not reach the mail provider" }, { status: 502 });
	}
}

/** Register a domain missing from the platform's SMTP2GO account (allowed even if nothing was ever added). */
export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	if (!env.MAILFLARE_TENANT) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	if (!canManageDomains(user) || !hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	try {
		await ensureSmtp2goDomain(env, domain);
		return NextResponse.json(await getDomainRecords(env, domain), { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Could not reach the mail provider" }, { status: 502 });
	}
}

export const GET = (request: Request, context: Params) => respond(request, context, false);
export const POST = (request: Request, context: Params) => respond(request, context, true);
