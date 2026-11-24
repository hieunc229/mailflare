import type { ProviderVerdicts, SpamSignal } from "../types";
import { SPAM_WEIGHTS } from "../weights";
import { findHeader } from "./utils";

/** Cloudflare Email Routing writes its verdicts under this authserv-id. */
const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";
const METHODS = ["dmarc", "dkim", "spf"] as const;

function methodSignal(method: (typeof METHODS)[number], result: string | undefined): SpamSignal | null {
	if (result === "pass") return { id: `${method}_passed`, score: SPAM_WEIGHTS.authentication[`${method}Pass`], reason: `${method.toUpperCase()} authentication passed` };
	if (result === "fail") return { id: `${method}_failed`, score: SPAM_WEIGHTS.authentication[`${method}Fail`], reason: `${method.toUpperCase()} authentication failed` };
	return null;
}

type Method = (typeof METHODS)[number];

/**
 * A sender can add Authentication-Results lines of its own, and duplicate headers arrive joined, so look at
 * every clause: only Cloudflare's exact authserv-id counts, a failure in any clause wins, and a pass needs all
 * of them to agree. A forged pass can then never hide a real fail.
 */
function trustedHeaderResults(headers?: Record<string, string>): Record<Method, "pass" | "fail" | undefined> {
	const value = findHeader(headers, "authentication-results");
	const out: Record<Method, "pass" | "fail" | undefined> = { dmarc: undefined, dkim: undefined, spf: undefined };
	if (!value) return out;
	const results: Record<Method, string[]> = { dmarc: [], dkim: [], spf: [] };
	for (const clause of value.split(/,\s*(?=[a-z0-9-]+(?:\.[a-z0-9-]+)+\s*;)/i)) {
		const authservId = clause.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		if (authservId !== TRUSTED_AUTHSERV_ID) continue;
		for (const method of METHODS) {
			const result = clause.match(new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i"))?.[1]?.toLowerCase();
			if (result) results[method].push(result);
		}
	}
	for (const method of METHODS) {
		const seen = results[method];
		out[method] = seen.includes("fail") ? "fail" : seen.length && seen.every((entry) => entry === "pass") ? "pass" : undefined;
	}
	return out;
}

/** The receiving side's own DMARC verdict for a message, by the same trust rules spam analysis uses. */
export function readTrustedDmarcResult(headers?: Record<string, string>, verdicts?: ProviderVerdicts): "pass" | "fail" | undefined {
	if (verdicts && (verdicts.spf || verdicts.dkim || verdicts.dmarc || verdicts.spam)) {
		const result = verdicts.dmarc?.toLowerCase();
		return result === "pass" || result === "fail" ? result : undefined;
	}
	return trustedHeaderResults(headers).dmarc;
}

/**
 * SPF, DKIM and DMARC results. Verdicts from the receiving provider (SES) win; otherwise only an
 * Authentication-Results clause written by Cloudflare is read. Self-hosted SMTP verifies SPF, DKIM
 * and DMARC itself (server/runtime/smtp-auth.ts) and passes the outcome in as verdicts.
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

	const results = trustedHeaderResults(headers);
	for (const method of METHODS) {
		const signal = methodSignal(method, results[method]);
		if (signal) signals.push(signal);
	}
	return signals;
}
