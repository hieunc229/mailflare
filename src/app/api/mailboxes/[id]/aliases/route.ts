import { and, eq, ne } from "drizzle-orm";
import { isReportAddressReserved } from "@/lib/deliverability/report-address";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { deleteEmailRoutingRuleForAddress, ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { parseRecipientAddress } from "@/lib/email/recipient-address";
import { newId } from "@/lib/ids";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { getMailboxSettingsAccess } from "@/lib/mailboxes/settings-access";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { mailboxAliasBodySchema, updateMailboxAliasSchema } from "@/lib/validators";
import type { MailboxRouteParams } from "../types";

async function getManagedMailbox(
	env: CloudflareEnv,
	user: Awaited<ReturnType<typeof requireUser>>,
	mailboxId: string,
) {
	const access = await getMailboxSettingsAccess(env, user, mailboxId);
	if (!access?.canManage) return null;
	const db = getDb(env);
	const [mailbox] = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart })
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	return mailbox ?? null;
}

async function getDomainOwnerId(db: ReturnType<typeof getDb>, domainId: string) {
	const [domain] = await db
		.select({ userId: domains.userId })
		.from(domains)
		.where(eq(domains.id, domainId))
		.limit(1);
	return domain?.userId ?? null;
}

// Masked addresses avoid characters that look alike when read aloud or copied.
const MASKED_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function generateMaskedLocalPart(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	return Array.from(bytes, (byte) => MASKED_ALPHABET[byte % MASKED_ALPHABET.length]).join("");
}

/** An alias is a new address, so it follows the same rule as creating a mailbox on the domain. */
function canCreateAddressesOn(user: Awaited<ReturnType<typeof requireUser>>, domainOwnerId: string) {
	return domainOwnerId === user.id || (user.canManageMailboxes && !!user.createdByUserId && domainOwnerId === user.createdByUserId);
}

/** Another mailbox that receives this address through "Use all domains", which an alias would silently take over. */
async function findAllDomainsMailboxFor(db: ReturnType<typeof getDb>, mailboxId: string, address: string) {
	const target = parseRecipientAddress(address)?.normalizedAddress;
	if (!target) return null;
	const candidates = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart, useAllDomains: mailboxes.useAllDomains })
		.from(mailboxes)
		.where(and(eq(mailboxes.useAllDomains, true), ne(mailboxes.id, mailboxId)));
	for (const candidate of candidates) {
		const addresses = await getMailboxDomainAddresses(db, candidate);
		if (addresses.some((item) => parseRecipientAddress(item)?.normalizedAddress === target)) return candidate;
	}
	return null;
}

function listMailboxAliases(db: ReturnType<typeof getDb>, mailboxId: string) {
	return db
		.select({
			id: mailboxAliases.id,
			domainId: mailboxAliases.domainId,
			localPart: mailboxAliases.localPart,
			label: mailboxAliases.label,
			enabled: mailboxAliases.enabled,
			masked: mailboxAliases.masked,
			hostname: domains.hostname,
			createdAt: mailboxAliases.createdAt,
		})
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(eq(mailboxAliases.mailboxId, mailboxId));
}

export async function GET(request: Request, { params }: MailboxRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const mailbox = await getManagedMailbox(env, user, id);
	if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

	const ownerId = await getDomainOwnerId(db, mailbox.domainId);
	const [aliases, availableDomains] = await Promise.all([
		listMailboxAliases(db, id),
		ownerId
			? db
					.select({ id: domains.id, hostname: domains.hostname })
					.from(domains)
					.where(and(eq(domains.userId, ownerId), eq(domains.status, "active")))
			: Promise.resolve([]),
	]);

	return NextResponse.json({ aliases, availableDomains });
}

export async function POST(request: Request, { params }: MailboxRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = mailboxAliasBodySchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: "Enter a valid alias username and domain" }, { status: 400 });
	}

	const db = getDb(env);
	const mailbox = await getManagedMailbox(env, user, id);
	if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

	const ownerId = await getDomainOwnerId(db, mailbox.domainId);
	const [domain] = ownerId && canCreateAddressesOn(user, ownerId)
		? await db
				.select({ id: domains.id, hostname: domains.hostname, zoneId: domains.zoneId, receivingProvider: domains.receivingProvider })
				.from(domains)
				.where(and(
					eq(domains.id, parsed.data.domainId),
					eq(domains.userId, ownerId),
					eq(domains.status, "active"),
				))
				.limit(1)
		: [];
	if (!domain) return NextResponse.json({ error: "Domain not found" }, { status: 404 });

	// Routing matches normalized local parts, so conflicts must too: an alias
	// that only differs by dots or a +suffix would shadow or be shadowed.
	const [domainMailboxes, domainAliases] = await Promise.all([
		db.select({ localPart: mailboxes.localPart }).from(mailboxes).where(eq(mailboxes.domainId, domain.id)),
		db.select({ localPart: mailboxAliases.localPart }).from(mailboxAliases).where(eq(mailboxAliases.domainId, domain.id)),
	]);
	const takenMailboxParts = new Set(domainMailboxes.map((row) => normalizeRecipientLocalPart(row.localPart)));
	const takenAliasParts = new Set(domainAliases.map((row) => normalizeRecipientLocalPart(row.localPart)));
	async function aliasAddressTaken(localPart: string): Promise<"mailbox" | "alias" | null> {
		const normalized = normalizeRecipientLocalPart(localPart);
		if (takenMailboxParts.has(normalized)) return "mailbox";
		if (takenAliasParts.has(normalized)) return "alias";
		// Another mailbox receiving this address through "Use all domains" would be silently shadowed.
		if (await findAllDomainsMailboxFor(db, id, `${localPart}@${domain.hostname}`)) return "mailbox";
		return null;
	}

	if (!parsed.data.generate && await isReportAddressReserved(env, domain.id, String(parsed.data.localPart))) {
		return NextResponse.json({ error: "This address is reserved for DMARC reports" }, { status: 409 });
	}

	const label = parsed.data.label || null;
	const masked = parsed.data.generate || parsed.data.masked;
	const candidates = parsed.data.generate
		? Array.from({ length: 5 }, generateMaskedLocalPart)
		: [parsed.data.localPart as string];

	let createdId: string | null = null;
	let createdLocalPart: string | null = null;
	let conflict: "mailbox" | "alias" | null = null;
	for (const localPart of candidates) {
		const taken = await aliasAddressTaken(localPart);
		if (taken) {
			conflict = taken;
			continue;
		}
		const inserted = await db
			.insert(mailboxAliases)
			.values({
				id: newId("als"),
				mailboxId: id,
				domainId: domain.id,
				localPart,
				label,
				masked,
			})
			.onConflictDoNothing()
			.returning({ id: mailboxAliases.id });
		if (inserted.length > 0) {
			createdId = inserted[0].id;
			createdLocalPart = localPart;
			break;
		}
		conflict = "alias";
	}
	if (!createdId || !createdLocalPart) {
		const error = parsed.data.generate
			? "Could not allocate an address, please try again"
			: conflict === "mailbox"
				? "A mailbox already uses this address"
				: "An alias already uses this address";
		return NextResponse.json({ error }, { status: 409 });
	}

	// Worker routes only matter when Cloudflare is what receives this domain's
	// mail; for Resend/SES domains the alias resolves inside provider intake.
	if (domain.receivingProvider === "cloudflare") {
		try {
			await ensureEmailRoutingRuleToWorker(env, domain.zoneId, `${createdLocalPart}@${domain.hostname}`);
		} catch (error) {
			console.error("ensureEmailRoutingRuleToWorker", error);
			await db.delete(mailboxAliases).where(eq(mailboxAliases.id, createdId));
			return NextResponse.json(
				{ error: "Failed to create the Cloudflare Email Routing rule for this alias. Please try again." },
				{ status: 502 },
			);
		}
	}

	const aliases = await listMailboxAliases(db, id);
	return NextResponse.json({ aliases });
}

export async function PATCH(request: Request, { params }: MailboxRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = updateMailboxAliasSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid alias update" }, { status: 400 });
	}

	const db = getDb(env);
	const mailbox = await getManagedMailbox(env, user, id);
	if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

	const [alias] = await db
		.select({
			id: mailboxAliases.id,
			localPart: mailboxAliases.localPart,
			hostname: domains.hostname,
			zoneId: domains.zoneId,
			receivingProvider: domains.receivingProvider,
		})
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(and(eq(mailboxAliases.id, parsed.data.aliasId), eq(mailboxAliases.mailboxId, id)))
		.limit(1);
	if (!alias) return NextResponse.json({ error: "Alias not found" }, { status: 404 });

	const updates: Partial<{ label: string | null; enabled: boolean }> = {};
	if (parsed.data.label !== undefined) updates.label = parsed.data.label || null;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) {
		return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
	}
	if (updates.enabled === true && alias.receivingProvider === "cloudflare") {
		// Re-enabling must restore delivery too: make sure the Cloudflare rule is
		// there before the worker starts accepting the address again.
		try {
			await ensureEmailRoutingRuleToWorker(env, alias.zoneId, `${alias.localPart}@${alias.hostname}`);
		} catch (error) {
			console.error("ensureEmailRoutingRuleToWorker", error);
			return NextResponse.json(
				{ error: "Failed to restore the Cloudflare Email Routing rule for this alias. Please try again." },
				{ status: 502 },
			);
		}
	}
	await db.update(mailboxAliases).set(updates).where(eq(mailboxAliases.id, alias.id));

	const aliases = await listMailboxAliases(db, id);
	return NextResponse.json({ aliases });
}

export async function DELETE(request: Request, { params }: MailboxRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const aliasId = new URL(request.url).searchParams.get("aliasId");
	if (!aliasId) return NextResponse.json({ error: "Alias is required" }, { status: 400 });

	const db = getDb(env);
	const mailbox = await getManagedMailbox(env, user, id);
	if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

	const [alias] = await db
		.select({
			id: mailboxAliases.id,
			domainId: mailboxAliases.domainId,
			localPart: mailboxAliases.localPart,
			hostname: domains.hostname,
			zoneId: domains.zoneId,
			receivingProvider: domains.receivingProvider,
		})
		.from(mailboxAliases)
		.innerJoin(domains, eq(mailboxAliases.domainId, domains.id))
		.where(and(eq(mailboxAliases.id, aliasId), eq(mailboxAliases.mailboxId, id)))
		.limit(1);
	if (!alias) return NextResponse.json({ error: "Alias not found" }, { status: 404 });

	// Keep the Cloudflare rule when the address still resolves through a
	// use-all-domains mailbox or another mailbox's alias on the same address.
	const [domainAliasMailbox] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(and(
			eq(mailboxes.localPart, alias.localPart),
			eq(mailboxes.useAllDomains, true),
			eq(mailboxes.disabled, false),
			ne(mailboxes.id, id),
		))
		.limit(1);

	if (!domainAliasMailbox && alias.receivingProvider === "cloudflare") {
		try {
			await deleteEmailRoutingRuleForAddress(env, alias.zoneId, `${alias.localPart}@${alias.hostname}`);
		} catch (error) {
			console.error("deleteEmailRoutingRuleForAddress", error);
			return NextResponse.json(
				{ error: "Failed to remove the Cloudflare Email Routing rule for this alias. Please try again." },
				{ status: 502 },
			);
		}
	}

	await db.delete(mailboxAliases).where(eq(mailboxAliases.id, aliasId));
	const aliases = await listMailboxAliases(db, id);
	return NextResponse.json({ aliases });
}
