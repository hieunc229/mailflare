import { getEmailAddress } from "@/lib/email/address";
import type { SeedMessageDefinition } from "@/lib/seed-types";

function addressDomain(address: string, fallback: string): string {
	const email = getEmailAddress(address).trim().toLowerCase();
	const at = email.lastIndexOf("@");
	return at >= 0 && at < email.length - 1 ? email.slice(at + 1) : fallback;
}

/** Builds RFC822 source with SES delivery headers for trusted demo messages. */
export function buildSeedRawMessage(message: SeedMessageDefinition, createdAt: Date): string {
	const options = message.raw;
	if (!options) throw new Error("A seed raw message needs delivery options");

	const fromDomain = addressDomain(message.fromAddr, "example.test");
	const signedBy = options.signedBy ?? fromDomain;
	const mailedBy = options.mailedBy ?? fromDomain;
	const senderIp = options.senderIp ?? "203.0.113.24";
	const toAddress = getEmailAddress(message.toAddr) || message.toAddr;
	const headers: string[] = [];

	if (options.trusted) {
		headers.push(
			`Return-Path: <bounce@${mailedBy}>`,
			`Received: from mail.${mailedBy} (mail.${mailedBy} [${senderIp}]) by inbound-smtp.us-east-1.amazonaws.com with SMTP id seed for <${toAddress}> (version=${options.tls ?? "TLSv1.3"}, cipher=TLS_AES_256_GCM_SHA384); ${createdAt.toUTCString()}`,
			`Authentication-Results: amazonses.com; spf=${options.spf ?? "pass"} (sender IP is ${senderIp}) smtp.mailfrom=${mailedBy}; dkim=${options.dkim ?? "pass"} header.d=${signedBy} header.i=@${signedBy}; dmarc=${options.dmarc ?? "pass"} header.from=${fromDomain};`,
			"X-SES-Spam-Verdict: PASS",
			"X-SES-Virus-Verdict: PASS",
			"X-SES-Receipt: seed",
		);
	} else {
		// Forged: no SES receipt, so readers must ignore it.
		headers.push(
			`Authentication-Results: amazonses.com; spf=pass smtp.mailfrom=${fromDomain}; dkim=pass header.d=${fromDomain}; dmarc=pass header.from=${fromDomain};`,
		);
	}

	headers.push(
		`From: ${message.fromAddr}`,
		`To: ${message.toAddr}`,
		...(message.ccAddr ? [`Cc: ${message.ccAddr}`] : []),
		...(message.bccAddr ? [`Bcc: ${message.bccAddr}`] : []),
		...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
		`Subject: ${message.subject}`,
		`Date: ${createdAt.toUTCString()}`,
		`Message-ID: ${message.providerMessageId ?? `<seed-${createdAt.getTime()}@example.test>`}`,
		...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
		...(message.references ? [`References: ${message.references}`] : []),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		message.textBody,
	);

	return headers.join("\r\n");
}
