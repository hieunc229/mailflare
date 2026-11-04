import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
	domains,
	mailboxes,
	messages,
	outboundJobs,
	users,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { ensureBookingUsername } from "@/lib/booking/username";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { buildSnippet } from "@/lib/email/parse";
import { newId } from "@/lib/ids";
import { buildSeedRawMessage } from "@/lib/seed-raw";
import type {
	SeedMailboxKey,
	SeedMailboxMap,
	SeedMessageDefinition,
} from "@/lib/seed-types";

export const demoCredentials = {
	email: "admin@example.com",
	password: "demo-password-change-me",
};

const demoDomain = "example.com";

const seedMailboxDefinitions: {
	key: SeedMailboxKey;
	localPart: string;
	displayName: string;
}[] = [
	{ key: "support", localPart: "support", displayName: "Support" },
	{ key: "billing", localPart: "billing", displayName: "Billing" },
];

export const seedMessages: SeedMessageDefinition[] = [
	{
		mailbox: "support",
		direction: "inbound",
		status: "received",
		fromAddr: `"Maya Chen" <maya@acme.test>`,
		toAddr: `"Support" <support@${demoDomain}>`,
		subject: "Cannot access workspace",
		textBody:
			"I reset my password this morning, but the login page still loops back to the sign-in screen. Can you check whether the account is locked?",
		read: false,
		minutesAgo: 12,
		providerMessageId: "<seed-inbox-access@example.test>",
	},
	{
		mailbox: "support",
		direction: "inbound",
		status: "received",
		fromAddr: `"Northwind DevOps" <devops@northwind.test>`,
		toAddr: `"Support" <support@${demoDomain}>`,
		subject: "Webhook retry question",
		textBody:
			"We noticed three delivery attempts for the same event. Is there a way to confirm whether retries stop after a 2xx response?",
		read: true,
		minutesAgo: 47,
		providerMessageId: "<seed-inbox-webhook@example.test>",
	},
	{
		mailbox: "billing",
		direction: "inbound",
		status: "received",
		fromAddr: `"Contoso Finance" <finance@contoso.test>`,
		toAddr: `"Billing" <billing@${demoDomain}>`,
		subject: "Invoice address update",
		textBody:
			"Please update our invoice contact to finance-team@contoso.test before the next billing cycle closes.",
		read: false,
		minutesAgo: 94,
		providerMessageId: "<seed-inbox-invoice@example.test>",
	},
	{
		mailbox: "support",
		direction: "outbound",
		status: "sent",
		fromAddr: `"Support" <support@${demoDomain}>`,
		toAddr: `"Maya Chen" <maya@acme.test>`,
		subject: "Re: Cannot access workspace",
		textBody:
			"I cleared the stale session and sent a fresh password reset link. Please try again from an incognito window.",
		read: true,
		minutesAgo: 8,
		providerMessageId: "<seed-sent-access@example.test>",
	},
	{
		mailbox: "billing",
		direction: "outbound",
		status: "sent",
		fromAddr: `"Billing" <billing@${demoDomain}>`,
		toAddr: `"Contoso Finance" <finance@contoso.test>`,
		subject: "Re: Invoice address update",
		textBody:
			"The billing contact is updated. Future invoices will go to finance-team@contoso.test.",
		read: true,
		minutesAgo: 35,
		providerMessageId: "<seed-sent-invoice@example.test>",
	},
	{
		mailbox: "support",
		direction: "outbound",
		status: "draft",
		fromAddr: `"Support" <support@${demoDomain}>`,
		toAddr: `"Northwind DevOps" <devops@northwind.test>`,
		subject: "Re: Webhook retry question",
		textBody:
			"Draft note: include retry backoff details, delivery log location, and the recommendation to return HTTP 204 after processing.",
		read: true,
		minutesAgo: 22,
	},
	{
		mailbox: "billing",
		direction: "outbound",
		status: "draft",
		fromAddr: `"Billing" <billing@${demoDomain}>`,
		toAddr: `"Globex Procurement" <procurement@globex.test>`,
		subject: "Annual plan renewal",
		textBody:
			"Draft renewal response with seat count, purchase order reference, and requested renewal date.",
		read: true,
		minutesAgo: 128,
	},
	{
		mailbox: "support",
		direction: "inbound",
		status: "spam",
		fromAddr: `"Traffic Promotions" <promo@unknown-sender.test>`,
		toAddr: `"Support" <support@${demoDomain}>`,
		subject: "Urgent traffic boost offer",
		textBody:
			"We can send thousands of visitors to your dashboard today. Reply now for the limited campaign rate.",
		read: false,
		minutesAgo: 166,
		providerMessageId: "<seed-spam-promo@example.test>",
	},
	{
		mailbox: "billing",
		direction: "inbound",
		status: "spam",
		fromAddr: `"Fake Bank Alerts" <alerts@fake-bank.test>`,
		toAddr: `"Billing" <billing@${demoDomain}>`,
		subject: "Payment account verification required",
		textBody:
			"Your payout account requires verification. Open the attached link and confirm your banking credentials.",
		read: true,
		minutesAgo: 219,
		providerMessageId: "<seed-spam-bank@example.test>",
	},
	{
		mailbox: "support",
		direction: "inbound",
		status: "trash",
		fromAddr: `"Vendor Migration" <old-thread@vendor.test>`,
		toAddr: `"Support" <support@${demoDomain}>`,
		subject: "Legacy migration thread",
		textBody:
			"This message was moved to trash after the migration checklist was completed and archived.",
		read: true,
		minutesAgo: 266,
		providerMessageId: "<seed-trash-migration@example.test>",
	},
	{
		mailbox: "billing",
		direction: "outbound",
		status: "trash",
		fromAddr: `"Billing" <billing@${demoDomain}>`,
		toAddr: `"Initech Ops" <ops@initech.test>`,
		subject: "Old billing draft",
		textBody:
			"Discarded copy of an earlier billing reply that was replaced by the final invoice response.",
		read: true,
		minutesAgo: 314,
	},
	{
		mailbox: "support",
		direction: "outbound",
		status: "queued",
		fromAddr: `"Support" <support@${demoDomain}>`,
		toAddr: `"Customer Status" <status@customer.test>`,
		subject: "Queued delivery status",
		textBody:
			"This seeded message represents an outbound email waiting for the worker queue to process.",
		read: true,
		minutesAgo: 4,
	},
	{
		mailbox: "billing",
		direction: "outbound",
		status: "queued",
		fromAddr: `"Billing" <billing@${demoDomain}>`,
		toAddr: `"Umbrella AP" <ap@umbrella.test>`,
		subject: "Queued payment receipt",
		textBody:
			"This seeded receipt is queued so API and background-job views can exercise pending delivery states.",
		read: true,
		minutesAgo: 17,
	},
	{
		mailbox: "support",
		direction: "outbound",
		status: "failed",
		fromAddr: `"Support" <support@${demoDomain}>`,
		toAddr: `"Invalid Bounce" <bounce@invalid.test>`,
		subject: "Failed SMTP handoff",
		textBody:
			"This seeded message failed delivery after the provider rejected the recipient address.",
		read: true,
		minutesAgo: 73,
	},
	{
		mailbox: "billing",
		direction: "outbound",
		status: "failed",
		fromAddr: `"Billing" <billing@${demoDomain}>`,
		toAddr: `"Closed Partner Account" <closed-account@partner.test>`,
		subject: "Failed billing notice",
		textBody:
			"This seeded billing notice failed because the destination mailbox no longer exists.",
		read: true,
		minutesAgo: 181,
	},
	// Sender-details demo set: threading, Reply-To, impersonation, and auth edge cases.
	{
		mailbox: "support",
		direction: "inbound",
		status: "received",
		fromAddr: `"Lumen Recruiting" <no-reply@lumenhq.test>`,
		toAddr: `"Support" <support@${demoDomain}>`,
		ccAddr: `"Maya Chen" <maya@acme.test>`,
		replyTo: `"Lumen Talent" <reply@lumenhq.test>`,
		subject: "Application received: Maya Chen",
		textBody:
			"We received Maya Chen's application for the platform engineer role. The hiring team will review it and follow up with next steps.",
		read: false,
		minutesAgo: 11,
		providerMessageId: "<seed-lumen-received@example.test>",
		threadId: "<seed-thread-lumen@example.test>",
		raw: {
			trusted: true,
			signedBy: "lumenhq.test",
			mailedBy: "lumenhq.test",
			senderIp: "203.0.113.24",
		},
	},
	{
		mailbox: "support",
		direction: "inbound",
		status: "received",
		fromAddr: `"Lumen Scheduling" <no-reply@lumenhq.test>`,
		toAddr: `"Support" <support@${demoDomain}>`,
		replyTo: `"Lumen Talent" <reply@lumenhq.test>`,
		subject: "Interview scheduled: Maya Chen",
		textBody:
			"Maya Chen's first interview is confirmed for Thursday at 10:00. The calendar invitation includes the meeting link and interviewer list.",
		read: false,
		minutesAgo: 7,
		providerMessageId: "<seed-lumen-scheduled@example.test>",
		threadId: "<seed-thread-lumen@example.test>",
		inReplyTo: "<seed-lumen-received@example.test>",
		references: "<seed-lumen-received@example.test>",
		raw: {
			trusted: true,
			signedBy: "lumenhq.test",
			mailedBy: "lumenhq.test",
			senderIp: "203.0.113.24",
		},
	},
	{
		mailbox: "billing",
		direction: "inbound",
		status: "received",
		fromAddr: `"Cobalt Finance" <finance@cobalt.test>`,
		toAddr: `"Billing" <billing@${demoDomain}>`,
		ccAddr: `"Maya Chen" <maya@acme.test>, "Northwind AP" <ap@northwind.test>`,
		bccAddr: `"Archive" <archive@example.com>`,
		replyTo: `"Cobalt Accounts" <accounts@cobalt.test>`,
		subject: "Invoice 2048 is ready",
		textBody:
			"Invoice 2048 is attached to the billing portal. The payment window closes at the end of the month, and the accounts team can answer questions about the purchase order.",
		read: true,
		minutesAgo: 38,
		providerMessageId: "<seed-cobalt-invoice@example.test>",
		raw: {
			trusted: true,
			signedBy: "cobalt.test",
			mailedBy: "cobalt.test",
			senderIp: "203.0.113.51",
		},
	},
	{
		mailbox: "billing",
		direction: "inbound",
		status: "received",
		fromAddr: `"Meridian Billing" <billing@meridian.test>`,
		toAddr: `"Billing" <billing@${demoDomain}>`,
		replyTo: `"Meridian Payments" <pay@meridian-payments.test>`,
		subject: "Payment method needs attention",
		textBody:
			"The card on file was declined for the latest subscription renewal. Update the payment method before Friday to avoid an interruption.",
		read: false,
		minutesAgo: 64,
		providerMessageId: "<seed-meridian-payment@example.test>",
		raw: {
			trusted: true,
			signedBy: "meridian.test",
			mailedBy: "meridian.test",
			senderIp: "203.0.113.77",
		},
	},
	{
		mailbox: "support",
		direction: "inbound",
		status: "received",
		fromAddr: `"security@cobaltbank.test" <alerts@cobalt-secure.test>`,
		toAddr: `"Support" <support@${demoDomain}>`,
		replyTo: `"Cobalt Security" <help@cobalt-help.test>`,
		subject: "Unusual sign-in attempt",
		textBody:
			"We blocked a sign-in from an unrecognized device. Confirm your identity and reset your password to protect the account.",
		read: false,
		minutesAgo: 92,
		providerMessageId: "<seed-cobalt-signin@example.test>",
		raw: {
			trusted: true,
			spf: "fail",
			dkim: "fail",
			dmarc: "fail",
			signedBy: "cobalt-secure.test",
			mailedBy: "cobalt-secure.test",
			senderIp: "198.51.100.42",
			tls: "TLSv1.2",
		},
	},
	{
		mailbox: "support",
		direction: "inbound",
		status: "received",
		fromAddr: `"Vendor Notice" <notice@vendor.test>`,
		toAddr: `"Support" <support@${demoDomain}>`,
		subject: "Updated vendor terms",
		textBody:
			"Review the updated vendor terms before the next renewal. This demo message carries a forged authentication header but no trusted delivery trace.",
		read: true,
		minutesAgo: 126,
		providerMessageId: "<seed-vendor-terms@example.test>",
		raw: {
			trusted: false,
		},
	},
];

export async function ensureDemoUser(env: CloudflareEnv) {
	const db = getDb(env);
	const [existing] = await db
		.select()
		.from(users)
		.where(eq(users.email, demoCredentials.email))
		.limit(1);
	const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
	if (existing) {
		// Repair demos seeded before the login page required an admin account.
		if (!admin) {
			await db.update(users).set({ role: "admin", isPrimaryAdmin: true }).where(eq(users.id, existing.id));
			return { ...existing, role: "admin" as const, isPrimaryAdmin: true };
		}
		return existing;
	}

	const id = newId("usr");
	await db.insert(users).values({
		id,
		remoteContentMode: "ask",
		email: demoCredentials.email,
		passwordHash: hashPassword(demoCredentials.password),
		name: "Demo User",
		role: admin ? "user" : "admin",
		isPrimaryAdmin: !admin,
	});
	await ensureBookingUsername(env, id, demoCredentials.email);

	const [created] = await db.select().from(users).where(eq(users.id, id)).limit(1);
	return created!;
}

export async function ensureDemoDomain(env: CloudflareEnv, userId: string) {
	const db = getDb(env);
	const [existing] = await db
		.select()
		.from(domains)
		.where(eq(domains.hostname, demoDomain))
		.limit(1);
	if (existing) return existing;

	const id = newId("dom");
	await db.insert(domains).values({
		id,
		userId,
		hostname: demoDomain,
		zoneId: "00000000000000000000000000000000",
		status: "active",
		routingEnabled: true,
		sendingRequested: true,
		sendingProvider: "cloudflare" as const,
		sendingEnabled: true,
	});

	const [created] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
	return created!;
}

export async function ensureDemoMailboxes(
	env: CloudflareEnv,
	userId: string,
	domainId: string,
): Promise<SeedMailboxMap> {
	const db = getDb(env);
	const entries = await Promise.all(
		seedMailboxDefinitions.map(async (definition) => {
			const [existing] = await db
				.select()
				.from(mailboxes)
				.where(
					and(
						eq(mailboxes.domainId, domainId),
						eq(mailboxes.localPart, definition.localPart),
					),
				)
				.limit(1);
			if (existing) return [definition.key, existing] as const;

			const id = newId("mbx");
			await db.insert(mailboxes).values({
				id,
				userId,
				domainId,
				localPart: definition.localPart,
				displayName: definition.displayName,
			});

			const [created] = await db
				.select()
				.from(mailboxes)
				.where(eq(mailboxes.id, id))
				.limit(1);
			return [definition.key, created!] as const;
		}),
	);

	return Object.fromEntries(entries) as SeedMailboxMap;
}

export async function insertDemoMessages(
	env: CloudflareEnv,
	userId: string,
	mailboxMap: SeedMailboxMap,
): Promise<number> {
	const db = getDb(env);
	const now = Date.now();

	for (const seedMessage of seedMessages) {
		const id = newId("msg");
		const createdAt = new Date(now - seedMessage.minutesAgo * 60 * 1000);
		const mailbox = mailboxMap[seedMessage.mailbox];
		const rawR2Key = seedMessage.raw ? `seed/${id}.eml` : null;
		if (rawR2Key) {
			await env.BUCKET.put(rawR2Key, buildSeedRawMessage(seedMessage, createdAt), {
				httpMetadata: { contentType: "message/rfc822" },
			});
		}

		await db.insert(messages).values({
			id,
			userId,
			mailboxId: mailbox.id,
			direction: seedMessage.direction,
			providerMessageId: seedMessage.providerMessageId ?? null,
			fromAddr: seedMessage.fromAddr,
			toAddr: seedMessage.toAddr,
			ccAddr: seedMessage.ccAddr ?? null,
			bccAddr: seedMessage.bccAddr ?? null,
			replyTo: seedMessage.replyTo ?? null,
			subject: seedMessage.subject,
			snippet: buildSnippet(seedMessage.textBody, null),
			textBody: seedMessage.textBody,
			htmlBody: null,
			rawR2Key,
			status: seedMessage.status,
			read: seedMessage.read ?? true,
			threadId: seedMessage.threadId ?? seedMessage.providerMessageId ?? null,
			inReplyTo: seedMessage.inReplyTo ?? null,
			references: seedMessage.references ?? null,
			createdAt,
		});

		if (seedMessage.status === "queued" || seedMessage.status === "failed") {
			await db.insert(outboundJobs).values({
				id: newId("job"),
				userId,
				messageId: id,
				status: seedMessage.status,
				payload: JSON.stringify({
					from: seedMessage.fromAddr,
					to: seedMessage.toAddr,
					subject: seedMessage.subject,
					text: seedMessage.textBody,
				}),
				error:
					seedMessage.status === "failed"
						? "Seeded delivery failure for UI and API testing"
						: null,
				createdAt,
				updatedAt: createdAt,
			});
		}

		await upsertContactFromAddress(env, {
			userId,
			address: seedMessage.direction === "inbound" ? seedMessage.fromAddr : seedMessage.toAddr,
			source: seedMessage.direction === "inbound" ? "inbound" : "outbound",
		});
	}

	return seedMessages.length;
}
