/**
 * DNS helper: publishes a domain's missing records at the customer's DNS host through that host's API.
 * Credentials are used for one request and never stored or logged. Only providers whose API works from a Worker
 * (no fixed source IP) are here: Namecheap requires an allow-listed IP and replaces the whole zone, so it is not.
 */
import { ProviderError, zoneCandidates, relative, need, call, type Adapter, type DnsCreds, type DnsProviderInfo, type DnsRecordResult, type DnsHelperResult, type Wanted } from "./dns-provider-kit";
import { MORE_ADAPTERS } from "./dns-providers-more";

export type { DnsCreds, DnsProviderInfo, DnsRecordResult, DnsHelperResult };
export { ProviderError };

const cloudflare: Adapter = {
	info: {
		id: "cloudflare", label: "Cloudflare",
		fields: [{ key: "token", label: "API token", secret: true }],
		help: "Create a token from the “Edit zone DNS” template, limited to this domain.",
		helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
	},
	async findZone(candidate, creds) {
		const { status, body } = await call(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}`, { headers: { Authorization: `Bearer ${need(creds, "token")}` } });
		if (status === 401 || status === 403) throw new ProviderError("Cloudflare rejected the token");
		const zone = body?.result?.[0];
		// A token with no zone access sees an empty list; the id is what the create call needs.
		return zone ? `${zone.id}|${zone.name}` : null;
	},
	async create(zone, rec, creds) {
		const [id, name] = zone.split("|");
		const { status, body } = await call(`https://api.cloudflare.com/client/v4/zones/${id}/dns_records`, {
			method: "POST",
			headers: { Authorization: `Bearer ${need(creds, "token")}`, "Content-Type": "application/json" },
			body: JSON.stringify({ type: rec.type, name: rec.name, content: rec.value, ttl: 1, proxied: false, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }),
		});
		if (status >= 200 && status < 300 && body?.success) return "added";
		const errors: { code: number; message: string }[] = body?.errors ?? [];
		if (errors.some((e) => e.code === 81057 || e.code === 81058)) return "exists";
		void name;
		throw new ProviderError(errors[0]?.message ?? `Cloudflare answered ${status}`);
	},
};

const godaddy: Adapter = {
	info: {
		id: "godaddy", label: "GoDaddy",
		fields: [{ key: "key", label: "API key" }, { key: "secret", label: "API secret", secret: true }],
		help: "Create a Production key. GoDaddy only allows API access on accounts with enough domains.",
		helpUrl: "https://developer.godaddy.com/keys",
	},
	async findZone(candidate, creds) {
		const { status } = await call(`https://api.godaddy.com/v1/domains/${encodeURIComponent(candidate)}`, { headers: { Authorization: `sso-key ${need(creds, "key")}:${need(creds, "secret")}` } });
		if (status === 401 || status === 403) throw new ProviderError("GoDaddy rejected the key (API access may be unavailable for this account)");
		return status === 200 ? candidate : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.godaddy.com/v1/domains/${zone}/records`, {
			method: "PATCH", // appends; PUT would replace every record of that type
			headers: { Authorization: `sso-key ${need(creds, "key")}:${need(creds, "secret")}`, "Content-Type": "application/json" },
			body: JSON.stringify([{ type: rec.type, name: relative(rec.name, zone, "@"), data: rec.value, ttl: 600, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }]),
		});
		if (status >= 200 && status < 300) return "added";
		if (status === 422 && /duplicate|already/i.test(body?.message ?? "")) return "exists";
		throw new ProviderError(body?.message ?? `GoDaddy answered ${status}`);
	},
};

const porkbun: Adapter = {
	info: {
		id: "porkbun", label: "Porkbun",
		fields: [{ key: "apikey", label: "API key" }, { key: "secretapikey", label: "Secret key", secret: true }],
		help: "Create a key, then turn on “API access” for the domain in its details.",
		helpUrl: "https://porkbun.com/account/api",
	},
	async findZone(candidate, creds) {
		const { status, body } = await call(`https://api.porkbun.com/api/json/v3/dns/retrieve/${encodeURIComponent(candidate)}`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apikey: need(creds, "apikey"), secretapikey: need(creds, "secretapikey") }),
		});
		if (body?.status === "SUCCESS") return candidate;
		if (status === 403 || /api key|secret/i.test(body?.message ?? "")) throw new ProviderError("Porkbun rejected the keys");
		return null;
	},
	async create(zone, rec, creds) {
		const { body } = await call(`https://api.porkbun.com/api/json/v3/dns/create/${zone}`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apikey: need(creds, "apikey"), secretapikey: need(creds, "secretapikey"), type: rec.type, name: relative(rec.name, zone, ""), content: rec.value, ttl: "600", ...(rec.type === "MX" ? { prio: String(rec.priority ?? 10) } : {}) }),
		});
		if (body?.status === "SUCCESS") return "added";
		if (/duplicate|already exist/i.test(body?.message ?? "")) return "exists";
		throw new ProviderError(body?.message ?? "Porkbun refused the record");
	},
};

const digitalocean: Adapter = {
	info: {
		id: "digitalocean", label: "DigitalOcean",
		fields: [{ key: "token", label: "API token", secret: true }],
		help: "Create a personal access token with write scope.",
		helpUrl: "https://cloud.digitalocean.com/account/api/tokens",
	},
	async findZone(candidate, creds) {
		const { status } = await call(`https://api.digitalocean.com/v2/domains/${encodeURIComponent(candidate)}`, { headers: { Authorization: `Bearer ${need(creds, "token")}` } });
		if (status === 401) throw new ProviderError("DigitalOcean rejected the token");
		return status === 200 ? candidate : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.digitalocean.com/v2/domains/${zone}/records`, {
			method: "POST",
			headers: { Authorization: `Bearer ${need(creds, "token")}`, "Content-Type": "application/json" },
			// Hostname targets must be fully qualified (trailing dot) or DigitalOcean appends the zone.
			body: JSON.stringify({ type: rec.type, name: relative(rec.name, zone, "@"), data: /^(CNAME|MX)$/.test(rec.type) ? `${rec.value}.` : rec.value, ttl: 600, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }),
		});
		if (status >= 200 && status < 300) return "added";
		throw new ProviderError(body?.message ?? `DigitalOcean answered ${status}`);
	},
};

const ADAPTERS: Record<string, Adapter> = { cloudflare, godaddy, porkbun, digitalocean, ...MORE_ADAPTERS };

export const DNS_PROVIDERS: DnsProviderInfo[] = Object.values(ADAPTERS).map((a) => a.info);

/** Adds every wanted record at `providerId`. Per-record failures are reported, not thrown; a bad token or unknown domain throws. */
export async function addRecordsAtProvider(providerId: string, hostname: string, wanted: Wanted[], creds: DnsCreds): Promise<DnsHelperResult> {
	const adapter = ADAPTERS[providerId];
	if (!adapter) throw new ProviderError("Unknown DNS provider");
	for (const f of adapter.info.fields) if (!creds[f.key]?.trim() || creds[f.key].length > 8192) throw new ProviderError("Fill in every field");
	let zone: string | null = null;
	for (const candidate of zoneCandidates(hostname)) {
		zone = await adapter.findZone(candidate, creds);
		if (zone) break;
	}
	if (!zone) throw new ProviderError(`${adapter.info.label} does not manage ${hostname} for this account`);
	const results: DnsRecordResult[] = [];
	for (const rec of wanted) {
		const base = { record: rec.record, type: rec.type, name: rec.name };
		try {
			results.push({ ...base, status: await adapter.create(zone, rec, creds) });
		} catch (error) {
			results.push({ ...base, status: "failed", error: error instanceof Error ? error.message : "Failed" });
		}
	}
	if (adapter.finish && results.some((r) => r.status === "added")) await adapter.finish(zone, creds).catch(() => undefined);
	return { provider: adapter.info.label, zone: zone.split("|").pop()!, results };
}

