import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { normalizeEmailAddress } from "@/lib/email/address";
import { inboundAttachmentLimitReasonFromRaw } from "@/lib/email/inbound-attachments";
import { intakeIncomingMail } from "@/lib/email/intake";
import { readHeaderMap, readSesTrace } from "@/lib/email/provider-trace";
import type { ProviderVerdicts } from "@/lib/spam/types";

export const MAX_PROVIDER_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * Hands a message a mail provider delivered (SES, Resend) to the normal intake,
 * once per recipient on a domain Mailflare manages. Routing rules, account
 * forwarding and storage then behave exactly as for Cloudflare mail. A provider
 * cannot refuse the message after it has been accepted, so a reject or a size
 * limit simply drops it. Throws on infrastructure failure so the provider retries.
 */
export async function intakeProviderMail(
	env: CloudflareEnv,
	input: { from: string; recipients: string[]; raw: ArrayBuffer; headers?: Record<string, string>; verdicts?: ProviderVerdicts },
): Promise<{ delivered: number; dropped: string | null }> {
	if (input.raw.byteLength > MAX_PROVIDER_MESSAGE_BYTES) return { delivered: 0, dropped: "Message exceeds the 25 MiB receiving limit" };
	const limit = await inboundAttachmentLimitReasonFromRaw(input.raw);
	if (limit) return { delivered: 0, dropped: limit };
	const trace = readSesTrace(input.raw);
	const verdicts = input.verdicts ?? trace.verdicts;
	if (verdicts?.virus?.toUpperCase() === "FAIL") return { delivered: 0, dropped: "Message failed the virus scan" };

	// Providers that give no header map (Resend) still get the plain headers read from the message.
	const headers = input.headers ?? readHeaderMap(input.raw);
	const db = getDb(env);
	let delivered = 0;
	for (const recipient of [...new Set(input.recipients.map(normalizeEmailAddress).filter(Boolean))]) {
		const hostname = recipient.slice(recipient.lastIndexOf("@") + 1);
		const [domain] = await db.select({ id: domains.id }).from(domains).where(eq(domains.hostname, hostname)).limit(1);
		if (!domain) continue;
		const result = await intakeIncomingMail(
			env,
			{ from: normalizeEmailAddress(input.from), to: recipient, raw: input.raw, headers, verdicts, senderIp: trace.senderIp },
			{ forward: async () => false },
		);
		if (result.action === "store") delivered += 1;
	}
	return { delivered, dropped: null };
}
