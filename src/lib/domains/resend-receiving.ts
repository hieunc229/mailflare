import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { isManualZone } from "@/lib/domains/provision";
import { hasMx, hasMxMatching, isInboundSmtpMx, publishMx, removeMx } from "@/lib/domains/receiving-dns";
import { getResendClient, getResendKeyStatus } from "@/lib/email/outbound-provider";
import {
	createResendDomain, createResendWebhook, deleteResendDomain, deleteResendWebhook, findResendDomain, getResendDomain,
	listResendWebhooks, ResendRestrictedKeyError, resendClient, updateResendCapabilities, verifyResendDomain, type ResendClient,
} from "@/lib/email/resend-api";
import type { ReceivingStep } from "@/lib/aws/ses-receiving-types";
import type { DomainRow } from "@/lib/domains/types";
import type { ResendReceivingView } from "@/lib/domains/resend-receiving-types";
import type { ResendDomainRecord } from "@/lib/email/resend-api-types";

export const resendWebhookUrl = (origin: string) => `${origin.replace(/\/$/, "")}/api/inbound/resend`;

export async function getResendWebhookSecret(env: CloudflareEnv): Promise<string | null> {
	const [row] = await getDb(env).select({ secret: appSettings.resendWebhookSecret }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
	return row?.secret ?? null;
}

async function storeWebhook(env: CloudflareEnv, id: string | null, secret: string | null): Promise<void> {
	const values = { resendWebhookId: id, resendWebhookSecret: secret, updatedAt: new Date() };
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
}

function inboundMx(records: ResendDomainRecord[] | undefined) {
	return (records ?? []).find((record) => record.type === "MX" && isInboundSmtpMx(record.value)) ?? null;
}

function isPublicHttps(origin: string): boolean {
	try {
		const url = new URL(origin);
		return url.protocol === "https:" && !/^(localhost|127\.|\[::1\]|.*\.localhost$|.*\.test$)/.test(url.hostname);
	} catch { return false; }
}

/** One webhook serves every domain; creating it returns the signing secret exactly once, so keep it. */
async function ensureWebhook(env: CloudflareEnv, client: ResendClient, origin: string): Promise<void> {
	const endpoint = resendWebhookUrl(origin);
	const existing = (await listResendWebhooks(client)).find((webhook) => webhook.endpoint === endpoint);
	if (existing && await getResendWebhookSecret(env)) return;
	// Resend only shows the secret at creation, so a hook we have no secret for is useless: replace it.
	if (existing) await deleteResendWebhook(client, existing.id);
	const created = await createResendWebhook(client, endpoint);
	await storeWebhook(env, created.id, created.signing_secret);
}

/**
 * Receiving through Resend: enable the receiving capability on the domain, point
 * its MX at Resend, register the `email.received` webhook, and ask Resend to verify.
 */
export async function setupResendReceiving(
	env: CloudflareEnv,
	domain: DomainRow,
	origin: string,
	options: { replaceMx: boolean },
): Promise<void> {
	if (!isPublicHttps(origin)) {
		throw new Error("Resend delivers mail by calling this app over public HTTPS. Set APP_URL to your public address (localhost will not work).");
	}
	const client = await getResendClient(env);
	let resend = await findResendDomain(client, domain.hostname);
	if (!resend) {
		const created = await createResendDomain(client, domain.hostname, { sending: domain.sendingProvider === "resend", receiving: true });
		resend = await getResendDomain(client, created.id);
	} else if (resend.capabilities?.receiving !== "enabled") {
		await updateResendCapabilities(client, resend.id, { receiving: true });
		resend = await getResendDomain(client, resend.id);
	}
	const mx = inboundMx(resend.records);
	if (!mx) throw new Error("Resend did not return a receiving MX record for this domain.");
	await publishMx(env, domain, mx.value, { replace: options.replaceMx, priority: mx.priority });
	await ensureWebhook(env, client, origin);
	await verifyResendDomain(client, resend.id).catch(() => undefined);
}

export async function getResendReceivingView(env: CloudflareEnv, domain: DomainRow, origin: string): Promise<ResendReceivingView> {
	const base = { dnsManaged: !isManualZone(domain.zoneId) };
	const key = await getResendKeyStatus(env);
	const steps: ReceivingStep[] = [{ key: "key", label: "Resend API key", ok: key.configured, detail: key.configured ? undefined : "Add a key under Sending or here" }];
	if (!key.configured || !key.apiKey) return { ...base, steps, ready: false, mx: null, restrictedKey: false };
	const client = resendClient(env, key.apiKey);
	try {
		const resend = await findResendDomain(client, domain.hostname);
		const enabled = resend?.capabilities?.receiving === "enabled";
		steps.push({ key: "domain", label: "Receiving enabled for this domain", ok: enabled, detail: !resend ? "Domain is not in Resend yet" : undefined });
		const mx = inboundMx(resend?.records);
		// A record Resend itself verified needs no second opinion. When Resend
		// names no inbound MX, any published inbound-smtp target proves the record.
		const mxOk = mx?.status === "verified"
			? true
			: mx
				? await hasMx(env, domain, mx.value)
				: await hasMxMatching(env, domain, isInboundSmtpMx);
		steps.push({ key: "mx", label: "MX record points to Resend", ok: mxOk === true, detail: mxOk === null ? "Could not check DNS from here" : mx?.value ?? undefined });
		steps.push({ key: "verified", label: "Domain verified", ok: resend?.status === "verified", detail: resend ? resend.status.replace(/_/g, " ") : undefined });
		const hooks = await listResendWebhooks(client);
		const hookOk = hooks.some((webhook) => webhook.endpoint === resendWebhookUrl(origin)) && !!(await getResendWebhookSecret(env));
		steps.push({ key: "webhook", label: "Webhook delivering mail to Mailflare", ok: hookOk });
		return { ...base, steps, ready: steps.every((step) => step.ok), mx: mx?.value ?? null, restrictedKey: false };
	} catch (error) {
		if (error instanceof ResendRestrictedKeyError) return { ...base, steps, ready: false, mx: null, restrictedKey: true };
		throw error;
	}
}

export async function hasResendReceivingConfig(env: CloudflareEnv, domain: DomainRow): Promise<boolean | null> {
	const { apiKey } = await getResendKeyStatus(env);
	if (!apiKey) return null;
	try { return (await findResendDomain(resendClient(env, apiKey), domain.hostname))?.capabilities?.receiving === "enabled"; }
	catch { return null; }
}

/** Switches receiving off for the domain and removes the MX. The shared webhook stays for other domains. */
export async function removeResendReceiving(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	const client = await getResendClient(env);
	const resend = await findResendDomain(client, domain.hostname);
	await removeMx(env, domain, isInboundSmtpMx);
	if (!resend) return;
	if (domain.sendingProvider === "resend") await updateResendCapabilities(client, resend.id, { receiving: false });
	else await deleteResendDomain(client, resend.id);
}
