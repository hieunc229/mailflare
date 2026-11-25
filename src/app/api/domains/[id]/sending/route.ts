import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getDomainForUser } from "@/lib/domains/service";
import { adoptCloudflareZone } from "@/lib/domains/adopt-zone";
import { isManualZone } from "@/lib/domains/provision";
import { findCloudflareSending, removeCloudflareSending } from "@/lib/domains/cloudflare-sending";
import { getAwsConfig } from "@/lib/aws/config";
import { getSesIdentity } from "@/lib/aws/ses";
import { removeSesSending } from "@/lib/aws/ses-sending";
import { getResendDomainStatus, removeResendConfig } from "@/lib/domains/resend-domain";
import { setupDomainDnsRecord } from "@/lib/domains/dns-setup";
import { MxConflictError } from "@/lib/domains/receiving-dns";
import { mtaStsBlockedResponse } from "@/lib/deliverability/mta-sts-block-response";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({ provider: z.enum(["none", "cloudflare", "resend", "ses"]), replaceMx: z.boolean().optional() });

/**
 * Chooses what sends mail for this domain. Receiving is unaffected, except that
 * Cloudflare sending refuses while another service's MX records exist: that is a
 * 409 MX_CONFLICT (the choice is still saved) until the caller retries with replaceMx.
 */
export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Unknown sending provider" }, { status: 400 });
	const { provider, replaceMx } = parsed.data;

	if (provider === "cloudflare" && isManualZone(domain.zoneId)) {
		// DNS was skipped when the domain was added: attach the real zone before enabling.
		try { domain = await adoptCloudflareZone(env, domain); }
		catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not find the Cloudflare zone" }, { status: 502 }); }
	}

	await getDb(env)
		.update(domains)
		.set({ sendingProvider: provider, sendingRequested: provider === "cloudflare" ? true : domain.sendingRequested })
		.where(eq(domains.id, domain.id));

	let warning: string | undefined;
	if (provider === "cloudflare" && !isManualZone(domain.zoneId)) {
		// Enable the zone's sending subdomain right away; failure is reported but the
		// choice is kept so the setup buttons on the domain page can finish the job.
		try { await setupDomainDnsRecord(env, { ...domain, sendingProvider: provider }, "dkim", { replaceMx }); }
		catch (error) {
			const blocked = await mtaStsBlockedResponse(error);
			if (blocked) return blocked;
			if (error instanceof MxConflictError) return NextResponse.json({ error: error.message, code: error.code, records: error.records }, { status: 409 });
			warning = error instanceof Error ? error.message : "Could not enable Cloudflare sending";
		}
	}
	const updated = await getDomainForUser(env, user.id, id);
	return NextResponse.json({ domain: updated, warning }, { headers: { "Cache-Control": "no-store" } });
}

/** Which providers have leftover configuration for this domain (null = could not tell). */
export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const [cloudflare, resendStatus, ses] = await Promise.all([
		findCloudflareSending(env, domain),
		getResendDomainStatus(env, domain),
		sesSendingStatus(env, domain.hostname),
	]);
	const resend = resendStatus === null ? null : resendStatus !== "not_registered";
	return NextResponse.json({ cloudflare: !!cloudflare, resend, resendStatus, ses: ses === null ? null : ses.registered, sesVerified: ses?.verified ?? null }, { headers: { "Cache-Control": "no-store" } });
}

async function sesSendingStatus(env: CloudflareEnv, hostname: string) {
	const config = await getAwsConfig(env);
	if (!config) return null;
	try { return await getSesIdentity(config, hostname); } catch { return null; }
}

const removeSchema = z.object({ target: z.enum(["cloudflare", "resend", "ses"]) });

/** Removes the config of a provider this domain is not using. */
export async function DELETE(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const parsed = removeSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
	if (parsed.data.target === domain.sendingProvider) {
		return NextResponse.json({ error: "Switch to another provider before removing this one" }, { status: 400 });
	}
	try {
		if (parsed.data.target === "cloudflare") await removeCloudflareSending(env, domain);
		else if (parsed.data.target === "resend") await removeResendConfig(env, domain);
		else await removeSesSending(env, domain);
		return NextResponse.json({ ok: true });
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Could not remove configuration" }, { status: 502 });
	}
}
