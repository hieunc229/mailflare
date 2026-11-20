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
import { receivingPresence, removeReceiving } from "@/lib/domains/receiving";
import { assertMxChangeAllowed } from "@/lib/deliverability/mta-sts-guard";
import { mtaStsBlockedResponse } from "@/lib/deliverability/mta-sts-block-response";

type Params = { params: Promise<{ id: string }> };

/** Chooses which provider receives mail for this domain. DNS is changed by that provider's own Setup. */
export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const parsed = z.object({ provider: z.enum(["none", "cloudflare", "resend", "ses"]) }).safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Unknown receiving provider" }, { status: 400 });
	// Switching who receives mail moves the MX; enforce senders would refuse the new host.
	if (parsed.data.provider !== domain.receivingProvider) {
		try { await assertMxChangeAllowed(env, domain); }
		catch (error) {
			const blocked = await mtaStsBlockedResponse(error);
			if (blocked) return blocked;
			throw error;
		}
	}
	await getDb(env).update(domains).set({ receivingProvider: parsed.data.provider }).where(eq(domains.id, domain.id));
	return NextResponse.json({ domain: await getDomainForUser(env, user.id, id) }, { headers: { "Cache-Control": "no-store" } });
}

/** Which providers still have receiving configuration for this domain. */
export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json(await receivingPresence(env, domain), { headers: { "Cache-Control": "no-store" } });
}

/** Removes the configuration of a provider this domain is not receiving through. */
export async function DELETE(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const parsed = z.object({ target: z.enum(["cloudflare", "resend", "ses"]) }).safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
	if (parsed.data.target === domain.receivingProvider) return NextResponse.json({ error: "Switch to another provider before removing this one" }, { status: 400 });
	try {
		await removeReceiving(env, domain, parsed.data.target);
		return NextResponse.json({ ok: true });
	} catch (error) {
		const blocked = await mtaStsBlockedResponse(error);
		if (blocked) return blocked;
		return NextResponse.json({ error: error instanceof Error ? error.message : "Could not remove configuration" }, { status: 502 });
	}
}
