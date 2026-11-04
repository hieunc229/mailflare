import type { ProviderVerdicts } from "@/lib/spam/types";

const AUTH_TIMEOUT_MS = 10_000;

type Result = { status?: { result?: string } } | false | undefined;

function verdict(result: string | undefined): string | undefined {
	if (result === "pass") return "PASS";
	if (result === "fail") return "FAIL";
	return undefined;
}

/**
 * SPF, DKIM and DMARC verified locally for mail that arrived on the SMTP listener, which has no
 * upstream provider to vouch for it. Returns nothing when verification cannot finish, so a DNS
 * outage adds no signal rather than blocking mail.
 */
export async function verifySmtpAuthentication(
	raw: Buffer,
	connection: { ip: string; helo?: string; sender: string; mta?: string },
): Promise<ProviderVerdicts | undefined> {
	try {
		const { authenticate } = await import("mailauth");
		const result = await Promise.race([
			authenticate(raw, { ip: connection.ip, helo: connection.helo, sender: connection.sender, mta: connection.mta, disableArc: true, disableBimi: true }),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Authentication timed out")), AUTH_TIMEOUT_MS)),
		]);
		const dkimResults = ((result.dkim as { results?: { status?: { result?: string } }[] } | undefined)?.results ?? []).map((entry) => entry.status?.result);
		const dkim = dkimResults.includes("pass") ? "PASS" : dkimResults.includes("fail") ? "FAIL" : undefined;
		const verdicts: ProviderVerdicts = {};
		const spf = verdict((result.spf as Result) ? (result.spf as { status?: { result?: string } }).status?.result : undefined);
		const dmarc = verdict((result.dmarc as Result) ? (result.dmarc as { status?: { result?: string } }).status?.result : undefined);
		if (spf) verdicts.spf = spf;
		if (dkim) verdicts.dkim = dkim;
		if (dmarc) verdicts.dmarc = dmarc;
		return Object.keys(verdicts).length ? verdicts : undefined;
	} catch (error) {
		console.warn("SMTP authentication check failed", error);
		return undefined;
	}
}
