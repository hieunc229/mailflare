import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes, users } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { newId } from "@/lib/ids";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { tracksAccountIdentity } from "@/lib/profile/identity-utils";
import { mailboxSchema } from "@/lib/validators";
import { ensureMailboxDomainRouting, getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { ensurePersonalMailbox } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const rows = await ensurePersonalMailbox(env, db, user);
	const entitlements = await getLicenseEntitlements(env);
	return NextResponse.json({
		mailboxes: await Promise.all(rows.map(async (mailbox) => ({
			...mailbox,
			...(mailbox.userId === user.id && tracksAccountIdentity(mailbox, user.email)
				? { displayName: user.name, hasAvatar: !!user.avatarKey }
				: {}),
			senderAddresses: await getMailboxDomainAddresses(db, mailbox),
		}))),
		canCreateShared: user.role === "admin" && entitlements.canShareMailboxes,
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = mailboxSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const mailboxType = parsed.data.type ?? "personal";
	if (mailboxType === "shared") {
		const entitlements = await getLicenseEntitlements(env);
		if (user.role !== "admin" || !entitlements.canShareMailboxes) {
			return NextResponse.json({ error: "A Team license is required to create shared inboxes" }, { status: 403 });
		}
	}
	const ownerUserId = mailboxType === "shared" ? user.id : parsed.data.ownerUserId ?? user.id;
	if (ownerUserId !== user.id) {
		if (user.role !== "admin") {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}
		const [owner] = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.id, ownerUserId), eq(users.createdByUserId, user.id)))
			.limit(1);
		if (!owner) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const [domain] = await db
		.select()
		.from(domains)
		.where(eq(domains.id, parsed.data.domainId))
		.limit(1);
	const canUseDomain = domain && (
		domain.userId === user.id ||
		(user.canManageMailboxes && !!user.createdByUserId && domain.userId === user.createdByUserId)
	);
	if (!canUseDomain) {
		return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	}

	const localPart = parsed.data.localPart.toLowerCase();
	// Inbound routing resolves normalized local parts, so a mailbox that only
	// differs by dots or a +tag would shadow the existing address either way.
	const [domainMailboxes, domainAliases] = await Promise.all([
		db.select({ localPart: mailboxes.localPart }).from(mailboxes).where(eq(mailboxes.domainId, domain.id)),
		db.select({ localPart: mailboxAliases.localPart }).from(mailboxAliases).where(eq(mailboxAliases.domainId, domain.id)),
	]);
	const normalized = normalizeRecipientLocalPart(localPart);
	if (domainMailboxes.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized)) {
		return NextResponse.json({ error: "Mailbox already exists" }, { status: 409 });
	}
	if (domainAliases.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized)) {
		return NextResponse.json({ error: "An alias already uses this address" }, { status: 409 });
	}

	const id = newId("mbx");
	await db.insert(mailboxes).values({
		id,
		userId: ownerUserId,
		domainId: parsed.data.domainId,
		localPart,
		displayName: parsed.data.displayName,
		type: mailboxType,
	});
	try {
		await ensureMailboxDomainRouting(env, db, { id, domainId: domain.id, localPart, useAllDomains: true });
	} catch (err) {
		await db.delete(mailboxes).where(eq(mailboxes.id, id));
		const message = err instanceof Error ? err.message : "Failed to create Cloudflare routing rule";
		return NextResponse.json({ error: message }, { status: 502 });
	}

	const address = `${localPart}@${domain.hostname}`;

	return NextResponse.json({
		id,
		address,
		type: mailboxType,
	});
}
