/**
 * What a workspace administrator manages about the workspace itself (not its mail): name, address, plan.
 * It lives in the control plane (`workspaces`, `subscriptions`), which the tenant Worker reaches through CONTROL.
 */

import { getStorageUsed, upgradeUrl } from "./limits";

export interface WorkspaceSettings {
	name: string;
	status: string;
	/** The workspace's main email domain, claimed at signup. */
	domain: string;
	/** `<label>.<workspace base domain>`: fixed at creation and always works. */
	defaultHost: string;
	/** The address the workspace is opened at: the default one, or a custom hostname on `domain`. */
	host: string;
	plan: { tier: string; status: string; periodEnd: number | null } | null;
	/** When a cancelled plan ends (the workspace works until then), or null. */
	cancelAt: number | null;
	limits: Record<string, number | undefined>;
	/** Bytes of attachments and Drive files stored, against `limits.storageBytes`. */
	storageUsed: number;
	/** Where billing is managed (the cloud app redirects to the payment portal). Null when not configured. */
	billingUrl: string | null;
	/** Where the owner upgrades from the free trial (no subscription yet). Null when not configured. */
	upgradeUrl: string | null;
}

const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type Row = { name: string; status: string; domain: string; default_host: string | null; subdomain: string | null; cancel_at: number | null; deletion: string | null };

async function load(env: CloudflareEnv): Promise<Row> {
	const tenant = env.MAILFLARE_TENANT;
	if (!tenant || !env.CONTROL) throw new Error("Not a hosted workspace");
	const row = await env.CONTROL.prepare("SELECT name, status, domain, default_host, subdomain, cancel_at, deletion FROM workspaces WHERE id = ?").bind(tenant.id).first<Row>();
	if (!row) throw new Error("Workspace not found");
	return row;
}

/** Labels a workspace address (`<label>.<workspace base domain>`) may not use. Keep in sync with the cloud app's `RESERVED_HOSTS`. */
const RESERVED_LABELS = new Set(["www", "app", "api", "mail", "admin", "c", "cdn", "static", "assets", "smtp", "imap", "ns1", "ns2", "status", "docs", "help", "support", "billing", "login", "signup", "localhost"]);
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

const baseOf = (defaultHost: string) => defaultHost.split(".").slice(1).join(".");

export interface HostAvailability { available: boolean; host: string; reason?: string }

/** Is `<label>.<workspace base domain>` free for this workspace? */
export async function checkLabelAvailable(env: CloudflareEnv, labelInput: string): Promise<HostAvailability> {
	const row = await load(env);
	const base = baseOf(row.default_host ?? "");
	const label = labelInput.trim().toLowerCase();
	const host = `${label}.${base}`;
	if (!base) return { available: false, host, reason: "This workspace has no base domain" };
	if (!LABEL_RE.test(label)) return { available: false, host, reason: "Use 3-40 lowercase letters, numbers or hyphens (not at the start or end)" };
	if (RESERVED_LABELS.has(label)) return { available: false, host, reason: "That name is reserved" };
	const taken = await env.CONTROL!.prepare("SELECT id FROM workspaces WHERE id != ? AND status != 'deleted' AND (lower(default_host) = ? OR lower(subdomain) = ?)").bind(env.MAILFLARE_TENANT!.id, host, host).first();
	if (taken) return { available: false, host, reason: "That name is already taken" };
	return { available: true, host };
}

const cloudHost = (env: CloudflareEnv) => {
	try { return env.CLOUD_URL ? new URL(env.CLOUD_URL).hostname.toLowerCase() : null; } catch { return null; }
};

export async function getWorkspaceSettings(env: CloudflareEnv): Promise<WorkspaceSettings> {
	const row = await load(env);
	const tenant = env.MAILFLARE_TENANT!;
	const sub = await env.CONTROL!.prepare("SELECT tier, status, period_end FROM subscriptions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1")
		.bind(tenant.id).first<{ tier: string; status: string; period_end: number | null }>();
	const defaultHost = row.default_host ?? "";
	return {
		name: row.name,
		status: row.status,
		domain: row.domain,
		defaultHost,
		host: row.subdomain ?? defaultHost,
		plan: sub ? { tier: sub.tier, status: sub.status, periodEnd: sub.period_end } : null,
		cancelAt: row.cancel_at,
		limits: { ...tenant.limits },
		storageUsed: await getStorageUsed(env),
		billingUrl: env.CLOUD_URL ? `${env.CLOUD_URL.replace(/\/$/, "")}/billing` : null,
		upgradeUrl: upgradeUrl(env),
	};
}

export interface AddressCheck {
	defaultHost: string;
	/** The optional second address (on the workspace's own domain), or null. */
	customHost: string | null;
	status: "none" | "ok" | "pending" | "error";
	/** What the DNS currently answers for the custom address. */
	found: string[];
}

/** Does the custom address point at the workspace's default address (CNAME, or the same IPs when the host is flattened/proxied)? */
export async function checkWorkspaceAddress(env: CloudflareEnv): Promise<AddressCheck> {
	const row = await load(env);
	const defaultHost = (row.default_host ?? "").toLowerCase();
	const customHost = row.subdomain && row.subdomain.toLowerCase() !== defaultHost ? row.subdomain.toLowerCase() : null;
	if (!customHost) return { defaultHost, customHost: null, status: "none", found: [] };
	const { queryDns } = await import("@/lib/dns-query");
	try {
		const cname = (await queryDns(customHost, "CNAME")).map((value) => value.replace(/\.$/, "").toLowerCase());
		if (cname.includes(defaultHost)) return { defaultHost, customHost, status: "ok", found: cname };
		const [mine, target] = await Promise.all([queryDns(customHost, "A"), queryDns(defaultHost, "A")]);
		if (mine.length && target.length && mine.every((ip) => target.includes(ip))) return { defaultHost, customHost, status: "ok", found: mine };
		return { defaultHost, customHost, status: "pending", found: cname.length ? cname : mine };
	} catch {
		return { defaultHost, customHost, status: "error", found: [] };
	}
}

/** Rename the workspace and/or move its primary address. Throws an Error with a message fit for the admin. */
export async function updateWorkspaceSettings(env: CloudflareEnv, input: { name?: string; label?: string }, actor: string): Promise<{ name: string; host: string }> {
	const row = await load(env);
	const id = env.MAILFLARE_TENANT!.id;
	const control = env.CONTROL!;
	const defaultHost = row.default_host ?? "";

	const name = input.name === undefined ? row.name : input.name.trim();
	if (!name || name.length > 60) throw new Error("Name must be 1-60 characters");

	// Move the default address (`<label>.<base>`). The primary address follows it unless a custom one is set.
	let newDefault = defaultHost;
	if (input.label !== undefined && input.label.trim()) {
		const check = await checkLabelAvailable(env, input.label);
		if (check.host !== defaultHost.toLowerCase() && !check.available) throw new Error(check.reason ?? "That name is not available");
		newDefault = check.host;
	}

	// Custom addresses are off for now (they would need a route to the tenant Worker): the primary address is always the default one.
	const host = newDefault;

	await control.prepare("UPDATE workspaces SET name = ?, subdomain = ?, default_host = ? WHERE id = ?").bind(name, host, newDefault, id).run();
	const at = Math.floor(Date.now() / 1000);
	if (host !== (row.subdomain ?? defaultHost)) {
		await control.prepare("INSERT INTO audit_log (id, at, actor, action, workspace_id, detail) VALUES (?, ?, ?, 'host_changed', ?, ?)")
			.bind(crypto.randomUUID(), at, actor, id, JSON.stringify({ from: row.subdomain, to: host })).run();
	}
	if (newDefault !== defaultHost) {
		await control.prepare("INSERT INTO audit_log (id, at, actor, action, workspace_id, detail) VALUES (?, ?, ?, 'default_host_changed', ?, ?)")
			.bind(crypto.randomUUID(), at, actor, id, JSON.stringify({ from: defaultHost, to: newDefault })).run();
	}
	return { name, host };
}

interface PaymugSubscription { id: string; title?: string; subtitle?: string; status?: string }

async function paymug<T>(env: CloudflareEnv, path: string, init?: RequestInit): Promise<T> {
	if (!env.PAYMUG_API_KEY) throw new Error("Cancelling here is not set up. Use Manage billing.");
	const base = (env.PAYMUG_URL || "https://store.paymug.co").replace(/\/$/, "");
	const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${env.PAYMUG_API_KEY}` } });
	if (!res.ok) throw new Error(res.status === 502 ? "The payment provider refused the cancellation. Try again later." : "Could not cancel the plan. Use Manage billing.");
	return (await res.json()) as T;
}

/**
 * Cancel the plan. Paymug stops billing right away (it cannot be undone), but the workspace keeps working until the end
 * of the paid period (`cancel_at`); then the cloud's cron makes it pending deletion for a week, then erases it.
 * The subscription is the stored id when Paymug lists it, else the single active one for the owner's email and plan.
 */
export async function cancelWorkspacePlan(env: CloudflareEnv, actor: string): Promise<{ cancelAt: number }> {
	const row = await load(env);
	if (row.status !== "active" && row.status !== "past_due") throw new Error("This workspace has no active plan");
	if (row.cancel_at) throw new Error("The plan is already cancelled");
	const id = env.MAILFLARE_TENANT!.id;
	const control = env.CONTROL!;
	const sub = await control.prepare("SELECT tier, status, paymug_subscription_id, period_end FROM subscriptions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1")
		.bind(id).first<{ tier: string; status: string; paymug_subscription_id: string | null; period_end: number | null }>();
	if (!sub || sub.status === "cancelled" || sub.status === "expired") throw new Error("This workspace has no active plan");
	const owner = await control.prepare("SELECT a.email, a.contact_email FROM accounts a JOIN workspaces w ON w.owner_id = a.id WHERE w.id = ?").bind(id).first<{ email: string; contact_email: string | null }>();
	const planRow = await control.prepare("SELECT name FROM plans WHERE tier = ?").bind(sub.tier).first<{ name: string }>();

	const { subscriptions } = await paymug<{ subscriptions: PaymugSubscription[] }>(env, "/api/v1/subscriptions");
	const emails = [owner?.email, owner?.contact_email].filter((e): e is string => !!e).map((e) => e.toLowerCase());
	const plan = (planRow?.name ?? sub.tier).toLowerCase();
	const found = subscriptions.find((s) => s.id === sub.paymug_subscription_id) ?? (() => {
		const hits = subscriptions.filter((s) => emails.includes((s.subtitle ?? "").toLowerCase()) && (s.title ?? "").toLowerCase().includes(plan) && !/cancel|expire/i.test(s.status ?? ""));
		return hits.length === 1 ? hits[0] : undefined;
	})();
	if (!found) throw new Error("Could not find the subscription. Cancel it with Manage billing.");
	await paymug(env, `/api/v1/subscriptions/${encodeURIComponent(found.id)}/cancel`, { method: "POST" });

	const now = Math.floor(Date.now() / 1000);
	// Unknown period end (not in the webhook payload): the plan ends now rather than guessing a date.
	const cancelAt = Math.max(now, sub.period_end ?? now);
	await control.batch([
		control.prepare("UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE workspace_id = ?").bind(now, id),
		control.prepare("UPDATE workspaces SET cancel_at = ? WHERE id = ?").bind(cancelAt, id),
		control.prepare("INSERT INTO audit_log (id, at, actor, action, workspace_id, detail) VALUES (?, ?, ?, 'plan_cancelled', ?, ?)")
			.bind(crypto.randomUUID(), now, actor, id, JSON.stringify({ cancelAt })),
	]);
	return { cancelAt };
}
