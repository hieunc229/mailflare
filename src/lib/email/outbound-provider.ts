import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, domains } from "@/db/schema";
import { requireAwsConfig } from "@/lib/aws/config";
import { sendSesEmail } from "@/lib/aws/ses";
import { getEmailAddress } from "@/lib/email/address";
import { getResendBaseUrl } from "@/lib/email/resend-api";
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

export async function getResendApiKey(env: CloudflareEnv): Promise<string> {
	const { apiKey } = await getResendKeyStatus(env);
	if (!apiKey) throw new Error("Resend is selected but no API key is configured");
	return apiKey;
}

/** The provider for the domain a message is sent from. */
export async function getOutboundProviderConfig(env: CloudflareEnv, fromAddress: string): Promise<OutboundProviderConfig> {
	const hostname = getEmailAddress(fromAddress).split("@")[1]?.toLowerCase();
	const [domain] = hostname
		? await getDb(env).select({ provider: domains.sendingProvider }).from(domains).where(eq(domains.hostname, hostname)).limit(1)
		: [];
	if (!domain || domain.provider === "none") {
		throw new Error(`Sending is not set up for ${hostname ?? "this domain"}. Choose a sending provider on the Domains page.`);
	}
	if (domain.provider === "resend") return { provider: "resend", apiKey: await getResendApiKey(env) };
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

async function sendWithResend(
	apiKey: string,
	message: OutboundProviderMessage,
	idempotencyKey?: string,
): Promise<{ messageId: string }> {
	const messageId = message.headers?.["Message-ID"] ?? mintMessageId(message.from);
	const response = await fetch(`${getResendBaseUrl()}/emails`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
		},
		body: JSON.stringify({
			from: message.from,
			to: message.to,
			...(message.cc?.length ? { cc: message.cc } : {}),
			...(message.bcc?.length ? { bcc: message.bcc } : {}),
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: { ...message.headers, "Message-ID": messageId },
			attachments: message.attachments?.map((attachment) => ({
				filename: attachment.filename,
				content: toBase64(attachment.content),
				content_type: attachment.type,
				...(attachment.disposition === "inline" && attachment.contentId ? { content_id: attachment.contentId } : {}),
			})),
		}),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(`Resend: ${body?.message ?? `request failed (${response.status})`}`);
	}
	return { messageId };
}

export async function sendThroughProvider(
	env: CloudflareEnv,
	config: OutboundProviderConfig,
	message: OutboundProviderMessage,
	idempotencyKey?: string,
): Promise<{ messageId: string }> {
	if (config.provider === "resend") return sendWithResend(config.apiKey, message, idempotencyKey);
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
