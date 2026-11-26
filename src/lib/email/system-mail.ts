import { and, asc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { formatEmailAddress } from "@/lib/email/address";
import { getOutboundProviderConfig, sendThroughProvider } from "@/lib/email/outbound-provider";
import type { SystemMailInput } from "@/lib/email/system-mail-types";

/**
 * Mail the application sends on its own behalf (password resets). It goes
 * straight through the send binding: no Sent copy, no contact upsert, no
 * webhooks, and the auto-generated headers mail systems expect.
 *
 * The From address is the primary mailbox of the first administrator on a
 * domain that can send; if no domain has sending enabled there is nothing to
 * send from, and the caller decides what to tell the user.
 */
export async function sendSystemEmail(env: CloudflareEnv, input: SystemMailInput): Promise<boolean> {
	const sender = await pickSystemSender(env, input.hostname);
	if (!sender) return false;

	const from = formatEmailAddress(sender.address, sender.name);
	await sendThroughProvider(env, await getOutboundProviderConfig(env, from), {
		from,
		to: [input.to],
		subject: input.subject,
		text: input.text,
		html: input.html,
		headers: {
			"Auto-Submitted": "auto-generated",
			"X-Auto-Response-Suppress": "All",
		},
	});
	return true;
}

export async function pickSystemSender(
	env: CloudflareEnv,
	hostname?: string,
): Promise<{ address: string; name: string } | null> {
	const db = getDb(env);
	const rows = await db
		.select({
			localPart: mailboxes.localPart,
			displayName: mailboxes.displayName,
			hostname: domains.hostname,
			role: users.role,
			provider: domains.sendingProvider,
			cloudflareSending: domains.sendingEnabled,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(and(
			ne(domains.sendingProvider, "none"),
			...(hostname ? [eq(domains.hostname, hostname.toLowerCase())] : []),
			eq(mailboxes.disabled, false),
			eq(users.disabled, false),
		))
		.orderBy(asc(mailboxes.createdAt))
		.limit(50);
	// Cloudflare sending only works once the zone's sending subdomain is enabled;
	// Resend is verified per domain in Resend itself.
	const usable = rows.filter((row) => row.provider !== "cloudflare" || row.cloudflareSending);
	const chosen = usable.find((row) => row.role === "admin") ?? usable[0];
	if (chosen) return { address: `${chosen.localPart}@${chosen.hostname}`, name: chosen.displayName ?? "Mailflare" };

	// No enabled mailbox on a sending domain: system mail does not need one, so
	// send from no-reply@ on any domain whose provider can send.
	const sendingDomains = await db
		.select({ hostname: domains.hostname, provider: domains.sendingProvider, cloudflareSending: domains.sendingEnabled })
		.from(domains)
		.where(and(
			ne(domains.sendingProvider, "none"),
			...(hostname ? [eq(domains.hostname, hostname.toLowerCase())] : []),
		))
		.limit(50);
	const domain = sendingDomains.find((row) => row.provider !== "cloudflare" || row.cloudflareSending);
	return domain ? { address: `no-reply@${domain.hostname}`, name: "Mailflare" } : null;
}
