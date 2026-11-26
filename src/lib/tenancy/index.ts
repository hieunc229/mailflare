import { openDatabaseFromExecutor } from "@/db/external";
import { tenantExecutor } from "./executor";
import { getB2Config, describeB2Problem } from "@/lib/storage/b2-config";
import { openB2Bucket } from "@/lib/storage/b2-bucket";
import { tenantLimitsFor } from "./plans";
import { routeBucket, scopeBucket, scopeNamespace, scopeQueue } from "./scope";
import type { TenantInfo, TenantLimits } from "./types";

/**
 * Multi-tenant mode: one deployment serves every workspace. The control plane (mailflare-cloud) owns a
 * D1 database bound as `CONTROL` with a `tenants` view; each tenant's data lives in its own Durable Object
 * (`TENANT_DB`), its files under a prefix of the shared bucket. Self-hosted installs have neither binding
 * and never reach this code.
 *
 * `tenants(id, host, status, domain, name, admin_email, admin_password_hash, admin_name, contact_email, limits)`: one row per hostname a workspace
 * answers to (so a workspace may appear twice). `limits` is JSON: the workspace's plan `tier` plus the operator's
 * overrides; `toTenant` turns it into `TenantLimits` with the plan table in ./plans (shared with the cloud app).
 */
export const SERVING_STATUSES = new Set<TenantInfo["status"]>(["active", "past_due"]);

/** Bindings a tenant must never inherit from the shared deployment: they would be shared with every other tenant. */
const SHARED_SECRETS = new Set(["CF_TOKEN", "CF_API_KEY", "CF_EMAIL", "INBOUND_WEBHOOK_SECRET", "DATABASE_URL", "DATABASE_DRIVER", "DATABASE_AUTH_TOKEN", "HYPERDRIVE", "DB_PRIMARY",
	// The shared files bucket: a workspace that saw these would make Mailflare's own `withStorage` swap its scoped BUCKET for the whole bucket.
	"B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);

interface Row { id: string; status: TenantInfo["status"]; domain: string; name: string | null; admin_email: string | null; admin_password_hash: string | null; admin_name: string | null; contact_email: string | null; limits: string | null }
const COLUMNS = "id, status, domain, name, admin_email, admin_password_hash, admin_name, contact_email, limits";

const TTL_MS = 15_000;
const cache = new Map<string, { until: number; tenant: TenantInfo | null }>();

function toTenant(row: Row | null): TenantInfo | null {
	if (!row) return null;
	let limits: TenantLimits = {};
	try {
		const { tier, activatedAt, subscribed, ...overrides } = row.limits ? (JSON.parse(row.limits) as { tier?: string; activatedAt?: number | null; subscribed?: number | boolean } & TenantLimits) : ({} as { tier?: string; activatedAt?: number | null; subscribed?: number | boolean });
		limits = tenantLimitsFor(tier, overrides, activatedAt, !!subscribed) as TenantLimits;
	} catch { /* unlimited */ }
	return { id: row.id, status: row.status, domain: row.domain, name: row.name || row.domain, adminEmail: row.admin_email, adminName: row.admin_name, adminPasswordHash: row.admin_password_hash, contactEmail: row.contact_email, limits };
}

async function lookup(env: CloudflareEnv, key: string, column: "host" | "id" | "label"): Promise<TenantInfo | null> {
	const cached = cache.get(`${column}:${key}`);
	if (cached && cached.until > Date.now()) return cached.tenant;
	const row = await env.CONTROL!.prepare(column === "label" ? `SELECT ${COLUMNS} FROM tenants WHERE host LIKE ? ESCAPE '\\' ORDER BY length(host) LIMIT 1` : `SELECT ${COLUMNS} FROM tenants WHERE ${column} = ?`).bind(column === "label" ? `${key.replace(/[\\%_]/g, "\\$&")}.%` : key).first<Row>();
	const tenant = toTenant(row);
	cache.set(`${column}:${key}`, { until: Date.now() + TTL_MS, tenant });
	return tenant;
}

/**
 * Mail attachments and Drive files live in Backblaze B2 when B2_* is set on the Worker (set it in production); without it
 * everything stays in R2, which is what local development uses.
 */
export function filesBucket(env: CloudflareEnv): R2Bucket | null {
	const config = getB2Config(env);
	if (!config) {
		const problem = describeB2Problem(env);
		if (problem) console.warn(`[tenant] files stay in R2: ${problem}`);
		return null;
	}
	return openB2Bucket(config);
}

export const isMultiTenant = (env: Partial<CloudflareEnv>) => !!env.CONTROL && !!env.TENANT_DB;

/** The workspace served at `host`: any hostname the control plane lists for it (its default address and its custom one). */
export async function findTenantByHost(env: CloudflareEnv, host: string): Promise<TenantInfo | null> {
	const name = host.toLowerCase().replace(/:\d+$/, "");
	const exact = await lookup(env, name, "host");
	if (exact || !name.endsWith(".localhost")) return exact;
	// Local development behind a tunnel that rewrites the Host header to `<label>.localhost`: the workspace whose
	// default address starts with that label.
	const label = name.slice(0, -".localhost".length);
	const byLabel = await lookup(env, label, "label");
	return byLabel;
}

export const findTenantById = (env: CloudflareEnv, id: string) => lookup(env, id, "id");

export async function listServingTenants(env: CloudflareEnv): Promise<TenantInfo[]> {
	const { results } = await env.CONTROL!.prepare(`SELECT ${COLUMNS} FROM tenants WHERE status IN ('active','past_due') GROUP BY id`).all<Row>();
	return results.map((row) => toTenant(row)!);
}

/** The env Mailflare runs with for one tenant: its own database, bucket slice, realtime names and queue stamps. */
export function tenantEnv(env: CloudflareEnv, tenant: TenantInfo): CloudflareEnv {
	const database = openDatabaseFromExecutor(tenantExecutor(env.TENANT_DB!.getByName(tenant.id)), { dialect: "sqlite", driver: "do-sqlite" });
	const prefix = `t/${tenant.id}/`;
	const files = filesBucket(env);
	const scoped: Record<string, unknown> = {
		DB: database,
		BUCKET: files ? routeBucket(scopeBucket(env.BUCKET, prefix), scopeBucket(files, prefix)) : scopeBucket(env.BUCKET, prefix),
		MAILFLARE_TENANT: tenant,
	};
	if (env.REALTIME) scoped.REALTIME = scopeNamespace(env.REALTIME, tenant.id);
	for (const name of ["INBOUND_QUEUE", "OUTBOUND_QUEUE", "AGENT_QUEUE"] as const) {
		if (env[name]) scoped[name] = scopeQueue(env[name] as Queue, tenant.id);
	}
	return new Proxy(env, {
		get(target, property) {
			if (typeof property === "string") {
				if (property in scoped) return scoped[property];
				if (SHARED_SECRETS.has(property)) return undefined;
			}
			return Reflect.get(target, property);
		},
	});
}

/** Delete a tenant's data: its database and every object under its prefix, in R2 and in the files bucket. A failure part way is retried by the next sweep. */
export async function destroyTenantData(env: CloudflareEnv, tenantId: string) {
	await env.TENANT_DB!.getByName(tenantId).destroy();
	const prefix = `t/${tenantId}/`;
	for (const bucket of [env.BUCKET, filesBucket(env)]) {
		if (!bucket) continue;
		let cursor: string | undefined;
		do {
			const page = await bucket.list({ prefix, cursor, limit: 1000 });
			if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
}
