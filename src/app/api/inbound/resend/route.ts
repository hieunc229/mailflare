import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getEmailAddress, getEmailAddressList } from "@/lib/email/address";
import { getResendClient } from "@/lib/email/outbound-provider";
import { intakeProviderMail } from "@/lib/email/provider-intake";
import { getReceivedEmail } from "@/lib/email/resend-api";
import { verifySvixSignature } from "@/lib/email/svix";
import { getResendWebhookSecret } from "@/lib/domains/resend-receiving";

export const dynamic = "force-dynamic";

type ReceivedEvent = { type?: string; data?: { email_id?: string; id?: string } };

/**
 * Resend's `email.received` webhook. The event only names the message, so fetch
 * it, download the raw MIME and run it through the normal intake. Authenticated
 * by the Svix signature of the secret Resend returned when the webhook was created.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const secret = await getResendWebhookSecret(env);
	if (!secret) return NextResponse.json({ error: "Resend receiving is not set up" }, { status: 503 });
	const body = await request.text();
	const valid = await verifySvixSignature(secret, {
		id: request.headers.get("svix-id"),
		timestamp: request.headers.get("svix-timestamp"),
		signature: request.headers.get("svix-signature"),
	}, body);
	if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

	let event: ReceivedEvent;
	try { event = JSON.parse(body) as ReceivedEvent; } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }
	if (event.type !== "email.received") return NextResponse.json({ ignored: true });
	const emailId = event.data?.email_id ?? event.data?.id;
	if (!emailId) return NextResponse.json({ error: "Missing email id" }, { status: 400 });

	const client = await getResendClient(env);
	const email = await getReceivedEmail(client, emailId);
	const download = email.raw?.download_url;
	if (!download) return NextResponse.json({ error: "Resend did not provide the raw message" }, { status: 502 });
	const rawResponse = await fetch(download);
	if (!rawResponse.ok) return NextResponse.json({ error: "Could not download the raw message" }, { status: 502 });

	const recipients = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])].flatMap((value) => getEmailAddressList(value));
	const result = await intakeProviderMail(env, { from: getEmailAddress(email.from), recipients, raw: await rawResponse.arrayBuffer() });
	return NextResponse.json(result);
}
