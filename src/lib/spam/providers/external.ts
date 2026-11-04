import { queryDns } from "@/lib/dns-query";
import { isPublicHttpsUrl } from "@/lib/security/public-url";
import { registrableDomain } from "../domain-utils";
import { cachedLookup } from "../lookup-cache";
import type { SpamIntelligenceConfig, SpamIntelligenceInput, SpamIntelligenceProvider, SpamSignal } from "../types";
import { SPAM_WEIGHTS } from "../weights";

const LOOKUP_TIMEOUT_MS = 2500;
const MAX_LINK_DOMAINS = 5;
const MAX_AGE_LINK_DOMAINS = 3;
const DAY = 24 * 60 * 60;
const MAX_REDIRECTS = 3;

/** Follows redirects by hand so every hop must stay on a public https host. */
async function fetchPublic(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		const response = await fetcher(current, { ...init, redirect: "manual" });
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		current = new URL(location, current).href;
		if (!isPublicHttpsUrl(current)) throw new Error("Lookup redirected to a non-public address");
	}
	throw new Error("Lookup redirected too many times");
}

const VALID_HOST = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

type BlocklistResult = { codes: string[] };
type UrlhausResult = { online: number };
type RdapResult = { registered: string | null };

function withTimeout<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), LOOKUP_TIMEOUT_MS); });
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Spamhaus answers 127.255.255.x for errors such as a refused or over-quota key; those are not listings. */
function listedCodes(answers: string[]): string[] {
	return answers.filter((answer) => answer.startsWith("127.") && !answer.startsWith("127.255.255."));
}

function strongest(signals: SpamSignal[]): SpamSignal[] {
	const byId = new Map<string, SpamSignal>();
	for (const signal of signals) {
		const current = byId.get(signal.id);
		if (!current || signal.score > current.score) byId.set(signal.id, signal);
	}
	return [...byId.values()];
}

/**
 * Network reputation checks: Spamhaus ZEN (sending IP) and DBL (sender and link domains) through the Data
 * Query Service, abuse.ch URLhaus for link domains, and domain registration age over RDAP. Every lookup is
 * cached, time-limited and optional; a failed lookup adds no signal rather than failing the analysis.
 */
export class ExternalSpamIntelligenceProvider implements SpamIntelligenceProvider {
	constructor(
		private readonly config: SpamIntelligenceConfig,
		private readonly bucket?: Pick<R2Bucket, "get" | "put">,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	async check(input: SpamIntelligenceInput): Promise<SpamSignal[]> {
		const sender = VALID_HOST.test(input.senderDomain) ? registrableDomain(input.senderDomain) : "";
		const links = [...new Set(input.urlDomains.filter((domain) => VALID_HOST.test(domain)).map(registrableDomain))]
			.filter((domain) => domain && domain !== sender)
			.slice(0, MAX_LINK_DOMAINS);
		const tasks: Promise<SpamSignal[]>[] = [];

		if (this.config.spamhausDqsKey) {
			if (input.senderIp) tasks.push(this.checkZen(input.senderIp));
			for (const domain of [sender, ...links].filter(Boolean)) tasks.push(this.checkDbl(domain, domain === sender));
		}
		if (this.config.abuseChAuthKey) {
			for (const domain of [sender, ...links].filter(Boolean)) tasks.push(this.checkUrlhaus(domain));
		}
		if (this.config.domainAge) {
			if (sender) tasks.push(this.checkAge(sender, true));
			for (const domain of links.slice(0, MAX_AGE_LINK_DOMAINS)) tasks.push(this.checkAge(domain, false));
		}

		const results = await Promise.allSettled(tasks.map(withTimeout));
		return strongest(results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
	}

	private async checkZen(ip: string): Promise<SpamSignal[]> {
		const reversed = ip.split(".").reverse().join(".");
		const { codes } = await cachedLookup<BlocklistResult>(this.bucket, `zen/${ip}`, () => DAY / 4, async () => ({
			codes: listedCodes(await queryDns(`${reversed}.${this.config.spamhausDqsKey}.zen.dq.spamhaus.net`, "A")),
		}));
		const last = codes.map((code) => Number(code.split(".")[3]));
		if (last.some((value) => [2, 3, 4, 5, 6, 7, 9].includes(value))) {
			return [{ id: "spamhaus_ip_listed", score: SPAM_WEIGHTS.blocklists.ipListed, reason: "The sending server is on a Spamhaus blocklist", metadata: { ip, codes } }];
		}
		if (last.some((value) => value === 10 || value === 11)) {
			return [{ id: "spamhaus_ip_dynamic", score: SPAM_WEIGHTS.blocklists.ipDynamic, reason: "The message was sent directly from an end-user IP address", metadata: { ip } }];
		}
		return [];
	}

	private async checkDbl(domain: string, isSender: boolean): Promise<SpamSignal[]> {
		const { codes } = await cachedLookup<BlocklistResult>(this.bucket, `dbl/${domain}`, () => DAY / 4, async () => ({
			codes: listedCodes(await queryDns(`${domain}.${this.config.spamhausDqsKey}.dbl.dq.spamhaus.net`, "A")),
		}));
		const last = codes.map((code) => Number(code.split(".")[3]));
		const where = isSender ? "The sender domain" : "A linked domain";
		if (last.some((value) => [4, 5, 6].includes(value))) {
			return [{ id: "spamhaus_domain_phish", score: SPAM_WEIGHTS.blocklists.domainPhishOrMalware, reason: `${where} is listed by Spamhaus for phishing or malware`, metadata: { domain } }];
		}
		if (last.includes(2)) {
			return [{ id: "spamhaus_domain_spam", score: SPAM_WEIGHTS.blocklists.domainSpam, reason: `${where} is listed by Spamhaus as a spam domain`, metadata: { domain } }];
		}
		if (last.some((value) => value >= 102 && value <= 106)) {
			return [{ id: "spamhaus_domain_abused", score: SPAM_WEIGHTS.blocklists.domainAbusedLegit, reason: `${where} is a legitimate domain currently abused by spammers`, metadata: { domain } }];
		}
		return [];
	}

	private async checkUrlhaus(domain: string): Promise<SpamSignal[]> {
		const { online } = await cachedLookup<UrlhausResult>(this.bucket, `urlhaus/${domain}`, () => DAY / 4, async () => {
			const response = await fetchPublic(this.fetcher, "https://urlhaus-api.abuse.ch/v1/host/", {
				method: "POST",
				headers: { "Auth-Key": this.config.abuseChAuthKey!, "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ host: domain }),
			});
			if (!response.ok) throw new Error(`URLhaus ${response.status}`);
			const data = (await response.json()) as { query_status?: string; urls?: { url_status?: string }[] };
			return { online: data.query_status === "ok" ? (data.urls ?? []).filter((url) => url.url_status === "online").length : 0 };
		});
		return online > 0
			? [{ id: "urlhaus_malware_host", score: SPAM_WEIGHTS.blocklists.urlMalware, reason: "A linked domain currently distributes malware (abuse.ch URLhaus)", metadata: { domain } }]
			: [];
	}

	private async checkAge(domain: string, isSender: boolean): Promise<SpamSignal[]> {
		const { registered } = await cachedLookup<RdapResult>(
			this.bucket,
			`rdap/${domain}`,
			(value) => (value.registered && Date.now() - Date.parse(value.registered) > 60 * DAY * 1000 ? 30 * DAY : DAY),
			async () => {
				const response = await fetchPublic(this.fetcher, `https://rdap.org/domain/${domain}`, { headers: { accept: "application/rdap+json" } });
				if (response.status === 404) return { registered: null };
				if (!response.ok) throw new Error(`RDAP ${response.status}`);
				const data = (await response.json()) as { events?: { eventAction?: string; eventDate?: string }[] };
				return { registered: data.events?.find((event) => event.eventAction === "registration")?.eventDate ?? null };
			},
		);
		const time = registered ? Date.parse(registered) : NaN;
		if (Number.isNaN(time)) return [];
		const days = (Date.now() - time) / (DAY * 1000);
		if (isSender && days < 7) return [{ id: "new_sender_domain", score: SPAM_WEIGHTS.domainAge.underWeek, reason: "The sender domain was registered less than a week ago", metadata: { domain, registered } }];
		if (isSender && days < 30) return [{ id: "young_sender_domain", score: SPAM_WEIGHTS.domainAge.underMonth, reason: "The sender domain was registered less than a month ago", metadata: { domain, registered } }];
		if (!isSender && days < 7) return [{ id: "new_link_domain", score: SPAM_WEIGHTS.domainAge.linkUnderWeek, reason: "A linked domain was registered less than a week ago", metadata: { domain, registered } }];
		return [];
	}
}
