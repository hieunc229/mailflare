import type { SnsEnvelope } from "@/lib/aws/ses-notification";

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const certCache = new Map<string, Promise<ArrayBuffer>>();

/** The fields SNS signs, in the order it signs them (Amazon SNS "Verifying the signatures" docs). */
function stringToSign(envelope: SnsEnvelope): string | null {
	const keys = envelope.Type === "Notification"
		? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
		: envelope.Type === "SubscriptionConfirmation" || envelope.Type === "UnsubscribeConfirmation"
			? ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
			: null;
	if (!keys) return null;
	let out = "";
	for (const key of keys) {
		const value = (envelope as Record<string, string | undefined>)[key];
		if (value === undefined) {
			if (key === "Subject") continue;
			return null;
		}
		out += `${key}\n${value}\n`;
	}
	return out;
}

export function isValidSigningCertUrl(value: string | undefined): value is string {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.port && CERT_HOST.test(url.hostname) && url.pathname.endsWith(".pem");
	} catch {
		return false;
	}
}

function pemToDer(pem: string): Uint8Array {
	const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
	return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

/** Reads one DER element at `offset`: its tag, header length and content length. */
function readDer(bytes: Uint8Array, offset: number): { tag: number; header: number; length: number } {
	const tag = bytes[offset];
	const first = bytes[offset + 1];
	if (first < 0x80) return { tag, header: 2, length: first };
	const count = first & 0x7f;
	let length = 0;
	for (let index = 0; index < count; index += 1) length = length * 256 + bytes[offset + 2 + index];
	return { tag, header: 2 + count, length };
}

/** Pulls the SubjectPublicKeyInfo out of an X.509 certificate; Web Crypto cannot import certificates. */
export function spkiFromCertificate(der: Uint8Array): Uint8Array {
	const cert = readDer(der, 0);
	let offset = cert.header;
	const tbs = readDer(der, offset);
	offset += tbs.header;
	const tbsEnd = offset + tbs.length;
	const skip = () => {
		const element = readDer(der, offset);
		offset += element.header + element.length;
	};
	if (der[offset] === 0xa0) skip(); // [0] version
	skip(); // serial
	skip(); // signature algorithm
	skip(); // issuer
	skip(); // validity
	skip(); // subject
	if (offset >= tbsEnd) throw new Error("Certificate has no public key");
	const spki = readDer(der, offset);
	return der.subarray(offset, offset + spki.header + spki.length);
}

async function fetchCertificate(url: string): Promise<ArrayBuffer> {
	const cached = certCache.get(url);
	if (cached) return cached;
	const pending = fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) }).then(async (response) => {
		if (!response.ok) throw new Error(`Signing certificate fetch failed: ${response.status}`);
		const der = pemToDer(await response.text());
		return der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;
	});
	certCache.set(url, pending);
	pending.catch(() => certCache.delete(url));
	return pending;
}

/** Checks the SNS signature against the certificate Amazon published. Returns false on any problem. */
export async function verifySnsSignature(
	envelope: SnsEnvelope,
	options: { now?: number; loadCertificate?: (url: string) => Promise<ArrayBuffer> } = {},
): Promise<boolean> {
	try {
		const version = envelope.SignatureVersion;
		if ((version !== "1" && version !== "2") || !envelope.Signature || !isValidSigningCertUrl(envelope.SigningCertURL)) return false;
		const signed = stringToSign(envelope);
		const sentAt = Date.parse(envelope.Timestamp ?? "");
		if (signed === null || Number.isNaN(sentAt) || Math.abs((options.now ?? Date.now()) - sentAt) > MAX_AGE_MS) return false;
		const der = new Uint8Array(await (options.loadCertificate ?? fetchCertificate)(envelope.SigningCertURL));
		const spki = spkiFromCertificate(der);
		const key = await crypto.subtle.importKey(
			"spki",
			spki as BufferSource,
			{ name: "RSASSA-PKCS1-v1_5", hash: version === "2" ? "SHA-256" : "SHA-1" },
			false,
			["verify"],
		);
		const signature = Uint8Array.from(atob(envelope.Signature), (char) => char.charCodeAt(0));
		return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(signed));
	} catch {
		return false;
	}
}
