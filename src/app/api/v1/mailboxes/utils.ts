import { NextResponse } from "next/server";
import { and, eq, or } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes, users } from "@/db/schema";
import { authenticateAdminApiKey, canShareAdminMailboxes } from "@/lib/api/admin-auth";
import { newId } from "@/lib/ids";
import { mailboxSchema } from "@/lib/validators";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "mailboxes");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const rows = await getDb(env).select({
		id: mailboxes.id, userId: mailboxes.userId, domainId: mailboxes.domainId,
		localPart: mailboxes.localPart, hostname: domains.hostname,
		displayName: mailboxes.displayName, type: mailboxes.type,
		disabled: mailboxes.disabled, createdAt: mailboxes.createdAt,
	}).from(mailboxes).innerJoin(users, eq(mailboxes.userId, users.id)).innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(or(eq(users.id, auth.userId), eq(users.createdByUserId, auth.userId)));
	return NextResponse.json({ mailboxes: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "mailboxes");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const parsed = mailboxSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const db = getDb(env);
	const mailboxType = parsed.data.type ?? "personal";
	if (mailboxType === "shared" && !(await canShareAdminMailboxes(env))) return NextResponse.json({ error: "A Team license is required to create shared inboxes" }, { status: 403 });
	const ownerUserId = mailboxType === "shared" ? auth.userId : parsed.data.ownerUserId ?? auth.userId;
	if (ownerUserId !== auth.userId) {
		const [owner] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, ownerUserId), eq(users.createdByUserId, auth.userId))).limit(1);
		if (!owner) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const [domain] = await db.select().from(domains).where(and(eq(domains.id, parsed.data.domainId), eq(domains.userId, auth.userId))).limit(1);
	if (!domain) return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	const localPart = parsed.data.localPart.toLowerCase();
	// Inbound routing resolves normalized local parts, so conflicts must too.
	const [domainMailboxes, domainAliases] = await Promise.all([
		db.select({ localPart: mailboxes.localPart }).from(mailboxes).where(eq(mailboxes.domainId, domain.id)),
		db.select({ localPart: mailboxAliases.localPart }).from(mailboxAliases).where(eq(mailboxAliases.domainId, domain.id)),
	]);
	const normalized = normalizeRecipientLocalPart(localPart);
	if (domainMailboxes.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized)) return NextResponse.json({ error: "Mailbox already exists" }, { status: 409 });
	if (domainAliases.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized)) return NextResponse.json({ error: "An alias already uses this address" }, { status: 409 });
	const id = newId("mbx");
	await db.insert(mailboxes).values({ id, userId: ownerUserId, domainId: domain.id, localPart, displayName: parsed.data.displayName, type: mailboxType });
	try {
		await ensureMailboxDomainRouting(env, db, { id, domainId: domain.id, localPart, useAllDomains: true });
	} catch (error) {
		await db.delete(mailboxes).where(eq(mailboxes.id, id));
		return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create Cloudflare routing rule" }, { status: 502 });
	}
	return NextResponse.json({ id, address: `${localPart}@${domain.hostname}`, type: mailboxType }, { status: 201 });
}
