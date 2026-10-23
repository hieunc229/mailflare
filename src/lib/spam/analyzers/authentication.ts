import type { ProviderVerdicts, SpamSignal } from "../types";
import { SPAM_WEIGHTS } from "../weights";
import { findHeader } from "./utils";

const METHODS = ["dmarc", "dkim", "spf"] as const;

function methodSignal(method: (typeof METHODS)[number], result: string | undefined): SpamSignal | null {
	if (result === "pass") return { id: `${method}_passed`, score: SPAM_WEIGHTS.authentication[`${method}Pass`], reason: `${method.toUpperCase()} authentication passed` };
	if (result === "fail") return { id: `${method}_failed`, score: SPAM_WEIGHTS.authentication[`${method}Fail`], reason: `${method.toUpperCase()} authentication failed` };
	return null;
}

/**
 * SPF, DKIM and DMARC results. Verdicts from the receiving provider (SES) win; otherwise only an
 * Authentication-Results header written by Cloudflare is trusted, since senders can add their own.
 */
export function analyzeAuthentication(headers?: Record<string, string>, verdicts?: ProviderVerdicts): SpamSignal[] {
	const signals: SpamSignal[] = [];
	if (verdicts && (verdicts.spf || verdicts.dkim || verdicts.dmarc || verdicts.spam)) {
		for (const method of METHODS) {
			const signal = methodSignal(method, verdicts[method]?.toLowerCase());
			if (signal) signals.push(signal);
		}
		if (verdicts.spam?.toLowerCase() === "fail") {
			signals.push({ id: "provider_spam_verdict", score: SPAM_WEIGHTS.provider.spamVerdict, reason: "The receiving mail provider classified this message as spam" });
		}
		return signals;
	}

	const value = findHeader(headers, "authentication-results");
	if (!value) return [];
	const authservId = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (!/(^|\.)cloudflare\.(com|net)$/.test(authservId)) return [];
	for (const method of METHODS) {
		const result = value.match(new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i"))?.[1]?.toLowerCase();
		const signal = methodSignal(method, result);
		if (signal) signals.push(signal);
	}
	return signals;
}
