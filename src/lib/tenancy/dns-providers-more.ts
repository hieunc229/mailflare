/**
 * More DNS hosts for the DNS helper. Same contract as dns-providers.ts: `findZone` says whether the account manages
 * a zone, `create` adds one record and never replaces existing ones. A record that already exists with other content
 * is reported as a failure with the host's own message, so the admin can fix it by hand.
 */
import { signAwsRequest } from "@/lib/aws/sigv4";
import { basic, call, fqdn, jsonHeaders, need, ProviderError, relative, type Adapter, type DnsCreds, type Wanted } from "./dns-provider-kit";

const ok = (status: number) => status >= 200 && status < 300;
const auth = (status: number) => status === 401 || status === 403;
const dup = (message: unknown) => /already exist|duplicate|identical/i.test(String(message ?? ""));
const form = (data: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() });
/** MX value as one string ("10 mx.example.com.") for hosts that keep the priority in the value. */
const mxValue = (rec: Wanted) => `${rec.priority ?? 10} ${fqdn(rec.value)}`;
/** Hosts that take a fully qualified target: hostname targets (CNAME, MX) get a trailing dot. */
const target = (rec: Wanted) => (rec.type === "MX" ? mxValue(rec) : rec.type === "CNAME" ? fqdn(rec.value) : rec.value);
const rejected = (label: string) => new ProviderError(`${label} rejected the credentials`);

/** Access tokens fetched once per request (the same creds object is passed to every call). */
const tokens = new WeakMap<DnsCreds, string>();

const vercel: Adapter = {
	info: { id: "vercel", label: "Vercel", fields: [{ key: "token", label: "API token", secret: true }], help: "Create an access token with scope for the account that owns the domain.", helpUrl: "https://vercel.com/account/tokens" },
	async findZone(c, creds) {
		const { status } = await call(`https://api.vercel.com/v5/domains/${encodeURIComponent(c)}`, { headers: { Authorization: `Bearer ${need(creds, "token")}` } });
		if (auth(status)) throw rejected("Vercel");
		return status === 200 ? c : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.vercel.com/v2/domains/${zone}/records`, {
			method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${need(creds, "token")}` }),
			body: JSON.stringify({ name: relative(rec.name, zone, ""), type: rec.type, value: rec.value, ttl: 60, ...(rec.type === "MX" ? { mxPriority: rec.priority ?? 10 } : {}) }),
		});
		if (ok(status)) return "added";
		if (dup(body?.error?.message)) return "exists";
		throw new ProviderError(body?.error?.message ?? `Vercel answered ${status}`);
	},
};

const netlify: Adapter = {
	info: { id: "netlify", label: "Netlify", fields: [{ key: "token", label: "Personal access token", secret: true }], help: "Create a personal access token.", helpUrl: "https://app.netlify.com/user/applications#personal-access-tokens" },
	async findZone(c, creds) {
		const { status, body } = await call("https://api.netlify.com/api/v1/dns_zones", { headers: { Authorization: `Bearer ${need(creds, "token")}` } });
		if (auth(status)) throw rejected("Netlify");
		const zone = Array.isArray(body) ? body.find((z: { name?: string }) => z.name?.toLowerCase() === c) : null;
		return zone ? `${zone.id}|${zone.name}` : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.netlify.com/api/v1/dns_zones/${zone.split("|")[0]}/dns_records`, {
			method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${need(creds, "token")}` }),
			body: JSON.stringify({ type: rec.type, hostname: rec.name, value: rec.value, ttl: 3600, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }),
		});
		if (ok(status)) return "added";
		if (dup(body?.message)) return "exists";
		throw new ProviderError(body?.message ?? `Netlify answered ${status}`);
	},
};

const hetzner: Adapter = {
	info: { id: "hetzner", label: "Hetzner", fields: [{ key: "token", label: "API token", secret: true }], help: "Create a read & write token in the project that holds the DNS zone (Hetzner Console).", helpUrl: "https://console.hetzner.cloud/" },
	async findZone(c, creds) {
		const { status, body } = await call(`https://api.hetzner.cloud/v1/zones?name=${encodeURIComponent(c)}`, { headers: { Authorization: `Bearer ${need(creds, "token")}` } });
		if (auth(status)) throw rejected("Hetzner");
		const zone = body?.zones?.[0];
		return zone ? `${zone.id}|${zone.name}` : null;
	},
	async create(zone, rec, creds) {
		const [id, name] = zone.split("|");
		const headers = jsonHeaders({ Authorization: `Bearer ${need(creds, "token")}` });
		const rr = relative(rec.name, name, "@");
		const value = target(rec);
		const first = await call(`https://api.hetzner.cloud/v1/zones/${id}/rrsets`, { method: "POST", headers, body: JSON.stringify({ name: rr, type: rec.type, ttl: 3600, records: [{ value }] }) });
		if (ok(first.status)) return "added";
		// The record set (name + type) exists: add our value to it, as for several MX records.
		if (first.status === 422 || first.status === 409) {
			const more = await call(`https://api.hetzner.cloud/v1/zones/${id}/rrsets/${encodeURIComponent(rr)}/${rec.type}/actions/add_records`, { method: "POST", headers, body: JSON.stringify({ records: [{ value }] }) });
			if (ok(more.status)) return "added";
			throw new ProviderError(more.body?.error?.message ?? `Hetzner answered ${more.status}`);
		}
		throw new ProviderError(first.body?.error?.message ?? `Hetzner answered ${first.status}`);
	},
};

const linode: Adapter = {
	info: { id: "linode", label: "Linode (Akamai)", fields: [{ key: "token", label: "Personal access token", secret: true }], help: "Create a token with read/write access to Domains.", helpUrl: "https://cloud.linode.com/profile/tokens" },
	async findZone(c, creds) {
		const { status, body } = await call("https://api.linode.com/v4/domains", { headers: { Authorization: `Bearer ${need(creds, "token")}`, "X-Filter": JSON.stringify({ domain: c }) } });
		if (auth(status)) throw rejected("Linode");
		const zone = body?.data?.[0];
		return zone ? `${zone.id}|${zone.domain}` : null;
	},
	async create(zone, rec, creds) {
		const [id, name] = zone.split("|");
		const { status, body } = await call(`https://api.linode.com/v4/domains/${id}/records`, {
			method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${need(creds, "token")}` }),
			body: JSON.stringify({ type: rec.type, name: relative(rec.name, name, ""), target: rec.value, ttl_sec: 300, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }),
		});
		if (ok(status)) return "added";
		throw new ProviderError(body?.errors?.[0]?.reason ?? `Linode answered ${status}`);
	},
};

const vultr: Adapter = {
	info: { id: "vultr", label: "Vultr", fields: [{ key: "token", label: "API key", secret: true }], help: "Enable the API and copy the key (allow access from any IP).", helpUrl: "https://my.vultr.com/settings/#settingsapi" },
	async findZone(c, creds) {
		const { status } = await call(`https://api.vultr.com/v2/domains/${encodeURIComponent(c)}`, { headers: { Authorization: `Bearer ${need(creds, "token")}` } });
		if (auth(status)) throw rejected("Vultr");
		return status === 200 ? c : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.vultr.com/v2/domains/${zone}/records`, {
			method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${need(creds, "token")}` }),
			body: JSON.stringify({ name: relative(rec.name, zone, ""), type: rec.type, data: rec.value, ttl: 300, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }),
		});
		if (ok(status)) return "added";
		throw new ProviderError(body?.error ?? `Vultr answered ${status}`);
	},
};

const gandi: Adapter = {
	info: { id: "gandi", label: "Gandi", fields: [{ key: "token", label: "Personal access token", secret: true }], help: "Create a token with “Manage domain name technical configurations”.", helpUrl: "https://admin.gandi.net/organizations/account/pat" },
	async findZone(c, creds) {
		const { status } = await call(`https://api.gandi.net/v5/livedns/domains/${encodeURIComponent(c)}`, { headers: { Authorization: `Bearer ${need(creds, "token")}` } });
		if (auth(status)) throw rejected("Gandi");
		return status === 200 ? c : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.gandi.net/v5/livedns/domains/${zone}/records`, {
			method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${need(creds, "token")}` }),
			body: JSON.stringify({ rrset_name: relative(rec.name, zone, "@"), rrset_type: rec.type, rrset_values: [target(rec)], rrset_ttl: 900 }),
		});
		if (ok(status)) return "added";
		if (status === 409 || dup(body?.message)) throw new ProviderError("A record with this name and type already exists; edit it by hand");
		throw new ProviderError(body?.message ?? `Gandi answered ${status}`);
	},
};

const desec: Adapter = {
	info: { id: "desec", label: "deSEC", fields: [{ key: "token", label: "API token", secret: true }], help: "Create a token under Token Management.", helpUrl: "https://desec.io/tokens" },
	async findZone(c, creds) {
		const { status } = await call(`https://desec.io/api/v1/domains/${encodeURIComponent(c)}/`, { headers: { Authorization: `Token ${need(creds, "token")}` } });
		if (auth(status)) throw rejected("deSEC");
		return status === 200 ? c : null;
	},
	async create(zone, rec, creds) {
		const headers = jsonHeaders({ Authorization: `Token ${need(creds, "token")}` });
		const sub = relative(rec.name, zone, "");
		const value = target(rec);
		const base = `https://desec.io/api/v1/domains/${zone}/rrsets/`;
		const made = await call(base, { method: "POST", headers, body: JSON.stringify({ subname: sub, type: rec.type, ttl: 3600, records: [value] }) });
		if (ok(made.status)) return "added";
		// An rrset with this name and type exists: append to its values.
		if (made.status === 400 && /same subdomain and type|already exist/i.test(JSON.stringify(made.body))) {
			const path = `${base}${sub || "@"}/${rec.type}/`;
			const old = await call(path, { headers });
			const records: string[] = old.body?.records ?? [];
			if (records.includes(value)) return "exists";
			const patched = await call(path, { method: "PATCH", headers, body: JSON.stringify({ records: [...records, value] }) });
			if (ok(patched.status)) return "added";
			throw new ProviderError(`deSEC answered ${patched.status}`);
		}
		throw new ProviderError(JSON.stringify(made.body ?? made.status).slice(0, 200));
	},
};

const dnsimple: Adapter = {
	info: { id: "dnsimple", label: "DNSimple", fields: [{ key: "token", label: "Account API token", secret: true }], help: "Use an account access token (not a user token).", helpUrl: "https://dnsimple.com/a/account/access_tokens" },
	async findZone(c, creds) {
		const headers = { Authorization: `Bearer ${need(creds, "token")}` };
		const who = await call("https://api.dnsimple.com/v2/whoami", { headers });
		if (auth(who.status)) throw rejected("DNSimple");
		const account = who.body?.data?.account?.id;
		if (!account) throw new ProviderError("Use a DNSimple account token, not a user token");
		const { status } = await call(`https://api.dnsimple.com/v2/${account}/zones/${encodeURIComponent(c)}`, { headers });
		return status === 200 ? `${account}|${c}` : null;
	},
	async create(zone, rec, creds) {
		const [account, name] = zone.split("|");
		const { status, body } = await call(`https://api.dnsimple.com/v2/${account}/zones/${name}/records`, {
			method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${need(creds, "token")}` }),
			body: JSON.stringify({ name: relative(rec.name, name, ""), type: rec.type, content: rec.value, ttl: 3600, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }),
		});
		if (ok(status)) return "added";
		if (dup(body?.message)) return "exists";
		throw new ProviderError(body?.message ?? `DNSimple answered ${status}`);
	},
};

const ns1: Adapter = {
	info: { id: "ns1", label: "NS1 (IBM)", fields: [{ key: "key", label: "API key", secret: true }], help: "Create an API key that may manage DNS zones and records.", helpUrl: "https://my.nsone.net/#/account/settings" },
	async findZone(c, creds) {
		const { status } = await call(`https://api.nsone.net/v1/zones/${encodeURIComponent(c)}`, { headers: { "X-NSONE-Key": need(creds, "key") } });
		if (auth(status)) throw rejected("NS1");
		return status === 200 ? c : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.nsone.net/v1/zones/${zone}/${rec.name}/${rec.type}`, {
			method: "PUT", headers: jsonHeaders({ "X-NSONE-Key": need(creds, "key") }),
			body: JSON.stringify({ zone, domain: rec.name, type: rec.type, ttl: 3600, answers: [{ answer: rec.type === "MX" ? [rec.priority ?? 10, rec.value] : [rec.value] }] }),
		});
		if (ok(status)) return "added";
		throw new ProviderError(body?.message ?? `NS1 answered ${status}`);
	},
};

const BUNNY_TYPES: Record<string, number> = { A: 0, AAAA: 1, CNAME: 2, TXT: 3, MX: 4 };
const bunny: Adapter = {
	info: { id: "bunny", label: "bunny.net", fields: [{ key: "key", label: "Account API key", secret: true }], help: "Use the account API key from your account settings.", helpUrl: "https://dash.bunny.net/account/settings" },
	async findZone(c, creds) {
		const { status, body } = await call(`https://api.bunny.net/dnszone?search=${encodeURIComponent(c)}`, { headers: { AccessKey: need(creds, "key") } });
		if (auth(status)) throw rejected("bunny.net");
		const zone = body?.Items?.find((z: { Domain?: string }) => z.Domain?.toLowerCase() === c);
		return zone ? `${zone.Id}|${zone.Domain}` : null;
	},
	async create(zone, rec, creds) {
		const [id, name] = zone.split("|");
		const { status, body } = await call(`https://api.bunny.net/dnszone/${id}/records`, {
			method: "PUT", headers: jsonHeaders({ AccessKey: need(creds, "key") }),
			body: JSON.stringify({ Type: BUNNY_TYPES[rec.type] ?? 3, Ttl: 300, Value: rec.value, Name: relative(rec.name, name, ""), Priority: rec.priority ?? 0, Weight: 0 }),
		});
		if (ok(status)) return "added";
		throw new ProviderError(body?.Message ?? `bunny.net answered ${status}`);
	},
};

const namecom: Adapter = {
	info: { id: "namecom", label: "Name.com", fields: [{ key: "user", label: "Username" }, { key: "token", label: "API token", secret: true }], help: "Request API access, then create a production token.", helpUrl: "https://www.name.com/account/settings/api" },
	async findZone(c, creds) {
		const { status } = await call(`https://api.name.com/v4/domains/${encodeURIComponent(c)}`, { headers: { Authorization: basic(need(creds, "user"), need(creds, "token")) } });
		if (auth(status)) throw rejected("Name.com");
		return status === 200 ? c : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.name.com/v4/domains/${zone}/records`, {
			method: "POST", headers: jsonHeaders({ Authorization: basic(need(creds, "user"), need(creds, "token")) }),
			body: JSON.stringify({ host: relative(rec.name, zone, ""), type: rec.type, answer: rec.value, ttl: 300, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }),
		});
		if (ok(status)) return "added";
		throw new ProviderError(body?.message ?? `Name.com answered ${status}`);
	},
};

/** NameSilo and DreamHost only take their key in the query string. */
const namesilo: Adapter = {
	info: { id: "namesilo", label: "NameSilo", fields: [{ key: "key", label: "API key", secret: true }], help: "Generate an API key in the API Manager.", helpUrl: "https://www.namesilo.com/account/api-manager" },
	async findZone(c, creds) {
		const { body } = await call(`https://www.namesilo.com/api/dnsListRecords?version=1&type=json&key=${encodeURIComponent(need(creds, "key"))}&domain=${encodeURIComponent(c)}`);
		const code = Number(body?.reply?.code);
		if (code === 110 || code === 105) throw rejected("NameSilo");
		return code === 300 ? c : null;
	},
	async create(zone, rec, creds) {
		const q = new URLSearchParams({ version: "1", type: "json", key: need(creds, "key"), domain: zone, rrtype: rec.type, rrhost: relative(rec.name, zone, ""), rrvalue: rec.value, rrttl: "3600", ...(rec.type === "MX" ? { rrdistance: String(rec.priority ?? 10) } : {}) });
		const { body } = await call(`https://www.namesilo.com/api/dnsAddRecord?${q}`);
		if (Number(body?.reply?.code) === 300) return "added";
		throw new ProviderError(body?.reply?.detail ?? "NameSilo refused the record");
	},
};

const dreamhost: Adapter = {
	info: { id: "dreamhost", label: "DreamHost", fields: [{ key: "key", label: "API key", secret: true }], help: "Create a key with the “dns-*” functions allowed.", helpUrl: "https://panel.dreamhost.com/?tree=home.api" },
	async findZone(c, creds) {
		const { body } = await call(`https://api.dreamhost.com/?${new URLSearchParams({ key: need(creds, "key"), cmd: "dns-list_records", format: "json" })}`);
		if (body?.result !== "success") throw new ProviderError(/invalid_api_key/.test(String(body?.data)) ? "DreamHost rejected the key" : `DreamHost: ${body?.data ?? "no answer"}`);
		return (body.data as { zone?: string }[]).some((r) => r.zone?.toLowerCase() === c) ? c : null;
	},
	async create(_zone, rec, creds) {
		const { body } = await call(`https://api.dreamhost.com/?${new URLSearchParams({ key: need(creds, "key"), cmd: "dns-add_record", format: "json", record: rec.name, type: rec.type, value: rec.type === "MX" ? `${rec.priority ?? 10} ${rec.value}` : rec.value })}`);
		if (body?.result === "success") return "added";
		if (/already_exists/.test(String(body?.data))) return "exists";
		throw new ProviderError(String(body?.data ?? "DreamHost refused the record"));
	},
};

const ionos: Adapter = {
	info: { id: "ionos", label: "IONOS", fields: [{ key: "key", label: "API key (prefix.secret)", secret: true }], help: "Create a key in the IONOS developer console (DNS API).", helpUrl: "https://developer.hosting.ionos.com/keys" },
	async findZone(c, creds) {
		const { status, body } = await call("https://api.hosting.ionos.com/dns/v1/zones", { headers: { "X-API-Key": need(creds, "key") } });
		if (auth(status)) throw rejected("IONOS");
		const zone = Array.isArray(body) ? body.find((z: { name?: string }) => z.name?.toLowerCase() === c) : null;
		return zone ? `${zone.id}|${zone.name}` : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.hosting.ionos.com/dns/v1/zones/${zone.split("|")[0]}/records`, {
			method: "POST", headers: jsonHeaders({ "X-API-Key": need(creds, "key") }),
			body: JSON.stringify([{ name: rec.name, type: rec.type, content: rec.value, ttl: 3600, prio: rec.type === "MX" ? (rec.priority ?? 10) : 0, disabled: false }]),
		});
		if (ok(status)) return "added";
		throw new ProviderError(body?.[0]?.message ?? body?.message ?? `IONOS answered ${status}`);
	},
};

const hostinger: Adapter = {
	info: { id: "hostinger", label: "Hostinger", fields: [{ key: "token", label: "API token", secret: true }], help: "Create an API token in your account.", helpUrl: "https://hpanel.hostinger.com/profile/api" },
	async findZone(c, creds) {
		const { status } = await call(`https://developers.hostinger.com/api/dns/v1/zones/${encodeURIComponent(c)}`, { headers: { Authorization: `Bearer ${need(creds, "token")}` } });
		if (auth(status)) throw rejected("Hostinger");
		return status === 200 ? c : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://developers.hostinger.com/api/dns/v1/zones/${zone}`, {
			method: "PUT", headers: jsonHeaders({ Authorization: `Bearer ${need(creds, "token")}` }),
			// overwrite:false keeps the existing records and only adds ours.
			body: JSON.stringify({ overwrite: false, zone: [{ name: relative(rec.name, zone, "@"), type: rec.type, ttl: 3600, records: [{ content: target(rec) }] }] }),
		});
		if (ok(status)) return "added";
		throw new ProviderError(body?.message ?? `Hostinger answered ${status}`);
	},
};

const scaleway: Adapter = {
	info: { id: "scaleway", label: "Scaleway", fields: [{ key: "key", label: "Secret key", secret: true }], help: "Create an API key allowed to manage Domains and DNS.", helpUrl: "https://console.scaleway.com/iam/api-keys" },
	async findZone(c, creds) {
		const { status, body } = await call(`https://api.scaleway.com/domain/v2beta1/dns-zones?domain=${encodeURIComponent(c)}&page_size=50`, { headers: { "X-Auth-Token": need(creds, "key") } });
		if (auth(status)) throw rejected("Scaleway");
		const zone = body?.dns_zones?.find((z: { domain: string; subdomain: string }) => (z.subdomain ? `${z.subdomain}.${z.domain}` : z.domain).toLowerCase() === c);
		return zone ? c : null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await call(`https://api.scaleway.com/domain/v2beta1/dns-zones/${zone}/records`, {
			method: "PATCH", headers: jsonHeaders({ "X-Auth-Token": need(creds, "key") }),
			body: JSON.stringify({ return_all_records: false, disallow_new_zone_creation: true, changes: [{ add: { records: [{ name: relative(rec.name, zone, ""), type: rec.type, data: rec.type === "MX" ? fqdn(rec.value) : rec.type === "CNAME" ? fqdn(rec.value) : rec.value, ttl: 3600, ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}) }] } }] }),
		});
		if (ok(status)) return "added";
		throw new ProviderError(body?.message ?? `Scaleway answered ${status}`);
	},
};

const cloudns: Adapter = {
	info: { id: "cloudns", label: "ClouDNS", fields: [{ key: "id", label: "API user ID (auth-id)" }, { key: "password", label: "API password", secret: true }], help: "Create an API user in the API settings (it needs access to the DNS zone).", helpUrl: "https://www.cloudns.net/api-settings/" },
	async findZone(c, creds) {
		const { body } = await call("https://api.cloudns.net/dns/get-zone-info.json", form({ "auth-id": need(creds, "id"), "auth-password": need(creds, "password"), "domain-name": c }));
		if (body?.status === "Success") return c;
		if (/invalid authentication|auth/i.test(String(body?.statusDescription))) throw rejected("ClouDNS");
		return null;
	},
	async create(zone, rec, creds) {
		const { body } = await call("https://api.cloudns.net/dns/add-record.json", form({ "auth-id": need(creds, "id"), "auth-password": need(creds, "password"), "domain-name": zone, "record-type": rec.type, host: relative(rec.name, zone, ""), record: rec.value, ttl: "3600", ...(rec.type === "MX" ? { priority: String(rec.priority ?? 10) } : {}) }));
		if (body?.status === "Success") return "added";
		if (dup(body?.statusDescription)) return "exists";
		throw new ProviderError(body?.statusDescription ?? "ClouDNS refused the record");
	},
};

const xmlEscape = (v: string) => v.replace(/[<>&'"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const ROUTE53 = "https://route53.amazonaws.com/2013-04-01";
async function route53Call(method: string, path: string, creds: DnsCreds, body = "") {
	const url = new URL(`${ROUTE53}${path}`);
	const headers = await signAwsRequest({ method, url, headers: body ? { "Content-Type": "text/xml" } : {}, body, region: "us-east-1", service: "route53", credentials: { accessKeyId: need(creds, "accessKeyId"), secretAccessKey: need(creds, "secretAccessKey") } });
	return call(url.toString(), { method, headers, ...(body ? { body } : {}) });
}
const route53: Adapter = {
	info: {
		id: "route53", label: "Amazon Route 53",
		fields: [{ key: "accessKeyId", label: "Access key ID" }, { key: "secretAccessKey", label: "Secret access key", secret: true }],
		help: "Use an IAM user whose policy allows route53:ListHostedZonesByName and route53:ChangeResourceRecordSets.",
		helpUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
	},
	async findZone(c, creds) {
		const { status, text } = await route53Call("GET", `/hostedzonesbydns?dnsname=${encodeURIComponent(c)}&maxitems=1`, creds);
		if (auth(status)) throw rejected("AWS");
		const match = /<HostedZone>\s*<Id>\/hostedzone\/([^<]+)<\/Id>\s*<Name>([^<]+)<\/Name>/.exec(text);
		// The list starts at the first name >= dnsname, so check it really is this zone.
		return match && match[2].toLowerCase() === `${c}.` ? `${match[1]}|${c}` : null;
	},
	async create(zone, rec, creds) {
		const value = rec.type === "MX" ? mxValue(rec) : rec.value;
		const xml = `<?xml version="1.0" encoding="UTF-8"?><ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Changes><Change><Action>CREATE</Action><ResourceRecordSet><Name>${xmlEscape(rec.name)}</Name><Type>${rec.type}</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>${xmlEscape(value)}</Value></ResourceRecord></ResourceRecords></ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
		const { status, text } = await route53Call("POST", `/hostedzone/${zone.split("|")[0]}/rrset`, creds, xml);
		if (ok(status)) return "added";
		const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? `Route 53 answered ${status}`;
		throw new ProviderError(/already exists/i.test(message) ? "A record set with this name and type already exists; edit it by hand" : message);
	},
};

function b64url(data: ArrayBuffer | string): string {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type ServiceAccount = { client_email: string; private_key: string; project_id: string };
function serviceAccount(creds: DnsCreds): ServiceAccount {
	try {
		const sa = JSON.parse(need(creds, "serviceAccount")) as ServiceAccount;
		if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error();
		return sa;
	} catch {
		throw new ProviderError("Paste the whole service-account JSON key file");
	}
}
async function googleToken(creds: DnsCreds): Promise<string> {
	const cached = tokens.get(creds);
	if (cached) return cached;
	const sa = serviceAccount(creds);
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/ndev.clouddns.readwrite", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }))}`;
	const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, "")), (ch) => ch.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]).catch(() => { throw new ProviderError("The service-account key is not valid"); });
	const jwt = `${unsigned}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)))}`;
	const { status, body } = await call("https://oauth2.googleapis.com/token", form({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }));
	if (!ok(status) || !body?.access_token) throw rejected("Google");
	tokens.set(creds, body.access_token);
	return body.access_token;
}
const googledns: Adapter = {
	info: {
		id: "googledns", label: "Google Cloud DNS",
		fields: [{ key: "serviceAccount", label: "Service-account JSON key", secret: true }],
		help: "Create a service account with the “DNS Administrator” role and paste its JSON key.",
		helpUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
	},
	async findZone(c, creds) {
		const sa = serviceAccount(creds);
		const token = await googleToken(creds);
		const { status, body } = await call(`https://dns.googleapis.com/dns/v1/projects/${encodeURIComponent(sa.project_id)}/managedZones?dnsName=${encodeURIComponent(`${c}.`)}`, { headers: { Authorization: `Bearer ${token}` } });
		if (auth(status)) throw rejected("Google");
		const zone = body?.managedZones?.find((z: { dnsName?: string; visibility?: string }) => z.dnsName?.toLowerCase() === `${c}.` && z.visibility !== "private");
		return zone ? `${sa.project_id}|${zone.name}|${c}` : null;
	},
	async create(zone, rec, creds) {
		const [project, name] = zone.split("|");
		const { status, body } = await call(`https://dns.googleapis.com/dns/v1/projects/${project}/managedZones/${name}/changes`, {
			method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${await googleToken(creds)}` }),
			body: JSON.stringify({ additions: [{ name: fqdn(rec.name), type: rec.type, ttl: 300, rrdatas: [target(rec)] }] }),
		});
		if (ok(status)) return "added";
		if (status === 409) throw new ProviderError("A record set with this name and type already exists; edit it by hand");
		throw new ProviderError(body?.error?.message ?? `Google answered ${status}`);
	},
};

async function azureToken(creds: DnsCreds): Promise<string> {
	const cached = tokens.get(creds);
	if (cached) return cached;
	const { status, body } = await call(`https://login.microsoftonline.com/${encodeURIComponent(need(creds, "tenantId"))}/oauth2/v2.0/token`, form({ grant_type: "client_credentials", client_id: need(creds, "clientId"), client_secret: need(creds, "clientSecret"), scope: "https://management.azure.com/.default" }));
	if (!ok(status) || !body?.access_token) throw rejected("Azure");
	tokens.set(creds, body.access_token);
	return body.access_token;
}
const AZURE_API = "api-version=2018-05-01";
const azure: Adapter = {
	info: {
		id: "azure", label: "Azure DNS",
		fields: [{ key: "tenantId", label: "Tenant ID" }, { key: "clientId", label: "Client (app) ID" }, { key: "clientSecret", label: "Client secret", secret: true }, { key: "subscriptionId", label: "Subscription ID" }],
		help: "Register an app and give it the “DNS Zone Contributor” role on the zone or its resource group.",
		helpUrl: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
	},
	async findZone(c, creds) {
		const token = await azureToken(creds);
		const sub = need(creds, "subscriptionId");
		const { status, body } = await call(`https://management.azure.com/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Network/dnszones?${AZURE_API}`, { headers: { Authorization: `Bearer ${token}` } });
		if (auth(status)) throw rejected("Azure");
		const zone = body?.value?.find((z: { name?: string }) => z.name?.toLowerCase() === c);
		const group = /\/resourceGroups\/([^/]+)/i.exec(zone?.id ?? "")?.[1];
		return zone && group ? `${sub}|${group}|${c}` : null;
	},
	async create(zone, rec, creds) {
		const [sub, group, name] = zone.split("|");
		const rel = relative(rec.name, name, "@");
		const url = `https://management.azure.com/subscriptions/${sub}/resourceGroups/${group}/providers/Microsoft.Network/dnsZones/${name}/${rec.type}/${encodeURIComponent(rel)}?${AZURE_API}`;
		const headers = jsonHeaders({ Authorization: `Bearer ${await azureToken(creds)}` });
		const existing = await call(url, { headers });
		const props: Record<string, any> = existing.status === 200 ? { ...existing.body?.properties } : { TTL: 3600 };
		if (rec.type === "MX") {
			const list: { preference: number; exchange: string }[] = props.MXRecords ?? [];
			if (list.some((m) => m.exchange.replace(/\.$/, "").toLowerCase() === rec.value)) return "exists";
			props.MXRecords = [...list, { preference: rec.priority ?? 10, exchange: rec.value }];
		} else if (rec.type === "CNAME") {
			if (existing.status === 200) {
				if (props.CNAMERecord?.cname?.replace(/\.$/, "").toLowerCase() === rec.value) return "exists";
				throw new ProviderError("A CNAME with this name already exists; edit it by hand");
			}
			props.CNAMERecord = { cname: rec.value };
		} else if (rec.type === "TXT") {
			props.TXTRecords = [...(props.TXTRecords ?? []), { value: [rec.value] }];
		} else {
			throw new ProviderError(`Record type ${rec.type} is not supported for Azure DNS`);
		}
		const { status, body } = await call(url, { method: "PUT", headers, body: JSON.stringify({ properties: props }) });
		if (ok(status)) return "added";
		throw new ProviderError(body?.error?.message ?? `Azure answered ${status}`);
	},
};

async function ovhCall(method: string, path: string, creds: DnsCreds, payload?: unknown) {
	const base = "https://eu.api.ovh.com/1.0";
	const url = `${base}${path}`;
	const body = payload === undefined ? "" : JSON.stringify(payload);
	const time = await call(`${base}/auth/time`);
	const ts = String(typeof time.body === "number" ? time.body : Math.floor(Date.now() / 1000));
	const raw = `${need(creds, "applicationSecret")}+${need(creds, "consumerKey")}+${method}+${url}+${body}+${ts}`;
	const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(raw));
	const signature = `$1$${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
	return call(url, {
		method,
		headers: jsonHeaders({ "X-Ovh-Application": need(creds, "applicationKey"), "X-Ovh-Consumer": need(creds, "consumerKey"), "X-Ovh-Timestamp": ts, "X-Ovh-Signature": signature }),
		...(body ? { body } : {}),
	});
}
const ovh: Adapter = {
	info: {
		id: "ovh", label: "OVHcloud (EU)",
		fields: [{ key: "applicationKey", label: "Application key" }, { key: "applicationSecret", label: "Application secret", secret: true }, { key: "consumerKey", label: "Consumer key", secret: true }],
		help: "Create an application, then a consumer key with GET/POST rights on /domain/zone/*. Uses the European endpoint.",
		helpUrl: "https://eu.api.ovh.com/createToken/",
	},
	async findZone(c, creds) {
		const { status, body } = await ovhCall("GET", `/domain/zone/${encodeURIComponent(c)}`, creds);
		if (status === 200) return c;
		if (auth(status) && /credential|consumer|application|signature/i.test(String(body?.message))) throw rejected("OVHcloud");
		return null;
	},
	async create(zone, rec, creds) {
		const { status, body } = await ovhCall("POST", `/domain/zone/${zone}/record`, creds, { fieldType: rec.type, subDomain: relative(rec.name, zone, ""), target: target(rec), ttl: 3600 });
		if (ok(status)) return "added";
		throw new ProviderError(body?.message ?? `OVHcloud answered ${status}`);
	},
	/** OVH keeps changes pending until the zone is refreshed. */
	async finish(zone, creds) {
		await ovhCall("POST", `/domain/zone/${zone}/refresh`, creds);
	},
};

export const MORE_ADAPTERS: Record<string, Adapter> = Object.fromEntries(
	[vercel, netlify, hetzner, linode, vultr, gandi, desec, dnsimple, ns1, bunny, namecom, namesilo, dreamhost, ionos, hostinger, scaleway, cloudns, route53, googledns, azure, ovh].map((a) => [a.info.id, a]),
);
