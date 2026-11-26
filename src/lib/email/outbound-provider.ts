import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, domains } from "@/db/schema";
import { requireAwsConfig } from "@/lib/aws/config";
import { sendSesEmail } from "@/lib/aws/ses";
import { isClaimedElsewhere } from "@/lib/tenancy/control";
import { getSmtp2goApiKey, smtp2goRequest } from "@/lib/tenancy/smtp2go";
import { getEmailAddress } from "@/lib/email/address";
import { fetchSentMessageId, resendClient, resendOmittedHeaders, resendSetsMessageId, type ResendClient } from "@/lib/email/resend-api";
import type { OutboundProviderConfig, OutboundProviderMessage, ResendKeyStatus } from "@/lib/email/outbound-provider-types";

/**
 * Each domain picks its own sender: Cloudflare Email Sending, Resend, or none
 * (receive-only). Receiving and storage always stay on Cloudflare. The Resend key
 * is shared by every domain; it comes from the admin setting, falling back to a
 * RESEND_API_KEY secret so it can be provisioned outside the database.
 */
export async function getResendKeyStatus(env: CloudflareEnv): Promise<ResendKeyStatus & { apiKey: string | null }> {
	const [settings] = await getDb(env)
		.select({ resendApiKey: appSettings.resendApiKey })
		.from(appSettings)
		.where(eq(appSettings.id, "default"))
		.limit(1);
	const saved = settings?.resendApiKey?.trim();
	const fromEnv = (env as { RESEND_API_KEY?: string }).RESEND_API_KEY?.trim();
	return {
		configured: !!(saved || fromEnv),
		source: saved ? "settings" : fromEnv ? "environment" : null,
		apiKey: saved || fromEnv || null,
	};
}

export async function getResendClient(env: CloudflareEnv): Promise<ResendClient> {
	const { apiKey } = await getResendKeyStatus(env);
	if (!apiKey) throw new Error("Resend is selected but no API key is configured");
	return resendClient(env, apiKey);
}

/** The provider for the domain a message is sent from. */
export async function getOutboundProviderConfig(env: CloudflareEnv, fromAddress: string): Promise<OutboundProviderConfig> {
	const hostname = getEmailAddress(fromAddress).split("@")[1]?.toLowerCase();
	const [row] = hostname
		? await getDb(env).select().from(domains).where(eq(domains.hostname, hostname)).limit(1)
		: [];
	// Hosted workspaces only send through SMTP2GO, and a domain is registered there only once the admin connects it on the Domains page.
	if (row && env.MAILFLARE_TENANT && row.sendingProvider !== "smtp2go") {
		throw new Error(`Sending is not set up for ${hostname}. Connect the domain on the Domains page first.`);
	}
	if (row && (await isClaimedElsewhere(env, row.hostname))) throw new Error(`${hostname} now belongs to another workspace`);
	const domain = row ? { provider: row.sendingProvider } : undefined;
	if (!domain || domain.provider === "none") {
		throw new Error(`Sending is not set up for ${hostname ?? "this domain"}. Choose a sending provider on the Domains page.`);
	}
	if (domain.provider === "smtp2go") return { provider: "smtp2go", apiKey: await getSmtp2goApiKey(env) };
	if (domain.provider === "resend") return { provider: "resend", apiKey: (await getResendClient(env)).apiKey };
	if (domain.provider === "ses") return { provider: "ses", config: await requireAwsConfig(env) };
	return { provider: "cloudflare" };
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/** Resend does not return the RFC 5322 Message-ID, so we mint one for replies to thread against. */
function mintMessageId(from: string): string {
	const domain = getEmailAddress(from).split("@")[1] || "mailflare.local";
	return `<${crypto.randomUUID()}@${domain}>`;
}

function resendPayload(message: OutboundProviderMessage, messageIdHeader: string | null, omitted: Set<string>) {
	// Drop any caller-supplied Message-ID so only the one decided here is sent,
	// and any header the configured service refuses.
	const headers = Object.fromEntries(Object.entries(message.headers ?? {})
		.filter(([name]) => name !== "Message-ID" && !omitted.has(name.toLowerCase())));
	return {
		from: message.from,
		to: message.to,
		...(message.cc?.length ? { cc: message.cc } : {}),
		...(message.bcc?.length ? { bcc: message.bcc } : {}),
		subject: message.subject,
		html: message.html,
		text: message.text,
		headers: messageIdHeader ? { ...headers, "Message-ID": messageIdHeader } : headers,
		attachments: message.attachments?.map((attachment) => ({
			filename: attachment.filename,
			content: toBase64(attachment.content),
			content_type: attachment.type,
			...(attachment.disposition === "inline" && attachment.contentId ? { content_id: attachment.contentId } : {}),
		})),
	};
}

async function sendWithResend(
	env: CloudflareEnv,
	client: ResendClient,
	message: OutboundProviderMessage,
	idempotencyKey?: string,
): Promise<{ messageId: string }> {
	const mintedId = message.headers?.["Message-ID"] ?? mintMessageId(message.from);
	const setsMessageId = resendSetsMessageId(env);
	const response = await fetch(`${client.baseUrl}/emails`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${client.apiKey}`,
			"Content-Type": "application/json",
			...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
		},
		body: JSON.stringify(resendPayload(message, setsMessageId ? mintedId : null, resendOmittedHeaders(env))),
	});
	const body = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;
	if (!response.ok) throw new Error(`Resend: ${body?.message ?? `request failed (${response.status})`}`);
	if (setsMessageId || !body?.id) return { messageId: mintedId };
	// Without our own header, thread replies against the ID the provider assigned.
	// It can be missing while the send is still queued; the minted ID is the fallback.
	return { messageId: (await fetchSentMessageId(client, body.id)) ?? mintedId };
}

/** SMTP2GO (hosted workspaces). It reports per-recipient failures with HTTP 200, so those are errors too. */
async function sendWithSmtp2go(apiKey: string, message: OutboundProviderMessage): Promise<{ messageId: string }> {
	const messageId = message.headers?.["Message-ID"] ?? mintMessageId(message.from);
	const headers = { ...message.headers, "Message-ID": messageId };
	const file = (attachment: NonNullable<OutboundProviderMessage["attachments"]>[number], filename: string) => ({ filename, mimetype: attachment.type, fileblob: toBase64(attachment.content) });
	const attachments = message.attachments ?? [];
	const data = await smtp2goRequest<{ failed?: number; failures?: unknown[] }>(apiKey, "/email/send", {
		sender: message.from,
		to: message.to,
		...(message.cc?.length ? { cc: message.cc } : {}),
		...(message.bcc?.length ? { bcc: message.bcc } : {}),
		subject: message.subject,
		...(message.html ? { html_body: message.html } : {}),
		...(message.text ? { text_body: message.text } : {}),
		custom_headers: Object.entries(headers).map(([header, value]) => ({ header, value })),
		attachments: attachments.filter((a) => !(a.disposition === "inline" && a.contentId)).map((a) => file(a, a.filename)),
		// SMTP2GO references inline images as cid:<filename>.
		inlines: attachments.filter((a) => a.disposition === "inline" && a.contentId).map((a) => file(a, a.contentId!)),
	});
	if (data.failed) throw new Error(`Mail delivery: ${JSON.stringify(data.failures ?? "send failed")}`);
	return { messageId };
}

export async function sendThroughProvider(
	env: CloudflareEnv,
	config: OutboundProviderConfig,
	message: OutboundProviderMessage,
	idempotencyKey?: string,
): Promise<{ messageId: string }> {
	if (config.provider === "smtp2go") return sendWithSmtp2go(config.apiKey, message);
	if (config.provider === "resend") return sendWithResend(env, resendClient(env, config.apiKey), message, idempotencyKey);
	if (config.provider === "ses") return sendSesEmail(config.config, message);
	const response = await env.EMAIL.send({
		from: message.from,
		to: message.to,
		...(message.cc?.length ? { cc: message.cc } : {}),
		...(message.bcc?.length ? { bcc: message.bcc } : {}),
		subject: message.subject,
		headers: message.headers && Object.keys(message.headers).length ? message.headers : undefined,
		html: message.html,
		text: message.text,
		attachments: message.attachments?.map((attachment) =>
			attachment.disposition === "inline" && attachment.contentId
				? { filename: attachment.filename, type: attachment.type, content: attachment.content, disposition: "inline" as const, contentId: attachment.contentId }
				: { filename: attachment.filename, type: attachment.type, content: attachment.content, disposition: "attachment" as const },
		),
	});
	return { messageId: response.messageId };
}
