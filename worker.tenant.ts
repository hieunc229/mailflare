/**
 * Entry point of a multi-tenant deployment (mailflare-cloud). It serves the stock Mailflare worker, once per
 * request, with the env of the workspace the hostname belongs to. Self-hosted installs use worker.ts.
 */
import worker, { RealtimeHub as StockRealtimeHub } from "./worker";
import { runWithTenantEnv } from "./src/lib/tenancy/context";
import { findTenantByHost, findTenantById, listServingTenants, SERVING_STATUSES, tenantEnv } from "./src/lib/tenancy";
import { TENANT_QUEUE_FIELD } from "./src/lib/tenancy/scope";
import { managedRouteResponse } from "./src/lib/tenancy/managed";
import { ensureTenantAdmin } from "./src/lib/tenancy/provision";

/**
 * The stock hub answers a client's revision ping with a query on `env.DB`, but a Durable Object only gets the raw
 * deployment env: no workspace database. The query threw, the hub closed the socket (1011) and the client
 * reconnected every second. The hub is named `<tenantId>:<userId>` (scopeNamespace), so it rebuilds the workspace env from that.
 */
export class RealtimeHub extends StockRealtimeHub {
	private tenantScoped = false;

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (!this.tenantScoped && message !== "ping") {
			const tenantId = (this.ctx.id as unknown as { name?: string }).name?.split(":")[0];
			const tenant = tenantId ? await findTenantById(this.env, tenantId) : null;
			if (tenant) (this as unknown as { env: CloudflareEnv }).env = tenantEnv(this.env, tenant);
			this.tenantScoped = true;
		}
		return super.webSocketMessage(socket, message);
	}
}
export { TenantDb } from "./src/lib/tenancy/tenant-db";

const html = (status: number, title: string, text: string) =>
	new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:28rem;padding:1.5rem"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></main>`, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});

export default {
	async fetch(request: Request, rawEnv: CloudflareEnv, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const tenant = await findTenantByHost(rawEnv, url.host);
		if (!tenant || tenant.status === "deleted" || tenant.status === "deleting") return html(404, "Workspace not found", "Check the address, or sign in at your Mailflare Cloud account.");
		if (!SERVING_STATUSES.has(tenant.status)) {
			return tenant.status === "suspended"
				? html(503, "Workspace suspended", "This workspace is suspended. Contact the workspace owner.")
				: html(503, "Workspace not ready", "This workspace is not active yet. Finish checkout in your Mailflare Cloud account.");
		}
		const blocked = managedRouteResponse(request, url);
		if (blocked) return blocked;
		const env = tenantEnv(rawEnv, tenant);
		return runWithTenantEnv(env, async () => {
			await ensureTenantAdmin(env, tenant);
			return worker.fetch(request, env, ctx);
		});
	},

	/** Queue messages carry the tenant that sent them; each tenant's share of the batch runs against its own env. */
	async queue(batch: MessageBatch, rawEnv: CloudflareEnv) {
		const byTenant = new Map<string, Message[]>();
		for (const message of batch.messages) {
			const id = (message.body as Record<string, unknown> | null)?.[TENANT_QUEUE_FIELD];
			if (typeof id !== "string") { message.ack(); continue; } // not stamped by a tenant: nothing can process it
			byTenant.set(id, [...(byTenant.get(id) ?? []), message]);
		}
		for (const [id, messages] of byTenant) {
			const tenant = await findTenantById(rawEnv, id);
			if (!tenant || tenant.status === "deleted") { for (const message of messages) message.ack(); continue; }
			if (tenant.status === "suspended") { for (const message of messages) message.retry({ delaySeconds: 300 }); continue; }
			const env = tenantEnv(rawEnv, tenant);
			const scoped = {
				queue: batch.queue,
				messages: messages.map((message) => ({ ...message, id: message.id, timestamp: message.timestamp, attempts: message.attempts, ack: () => message.ack(), retry: (options?: QueueRetryOptions) => message.retry(options), body: stripStamp(message.body) })),
				ackAll: () => messages.forEach((message) => message.ack()),
				retryAll: (options?: QueueRetryOptions) => messages.forEach((message) => message.retry(options)),
			} as unknown as MessageBatch;
			await runWithTenantEnv(env, () => worker.queue(scoped, env));
		}
	},

	/**
	 * Inbound mail (Cloudflare Email Routing): the one workspace claiming the recipient domain in CONTROL.domains
	 * takes it, with its own env. Unknown or non-serving domains are rejected.
	 */
	async email(message: ForwardableEmailMessage, rawEnv: CloudflareEnv, ctx: ExecutionContext) {
		const domain = message.to.split("@").pop()?.toLowerCase().trim();
		const owner = domain && rawEnv.CONTROL
			? await rawEnv.CONTROL.prepare("SELECT workspace_id FROM domains WHERE domain = ?").bind(domain).first<{ workspace_id: string }>()
			: null;
		const tenant = owner ? await findTenantById(rawEnv, owner.workspace_id) : null;
		if (!tenant || !SERVING_STATUSES.has(tenant.status)) { message.setReject("Unknown recipient"); return; }
		const env = tenantEnv(rawEnv, tenant);
		await runWithTenantEnv(env, () => worker.email(message, env, ctx));
	},

	/** Mailflare's upkeep (retention, reminders, scheduled sends) runs for every serving tenant. */
	async scheduled(controller: ScheduledController, rawEnv: CloudflareEnv, ctx: ExecutionContext) {
		for (const tenant of await listServingTenants(rawEnv)) {
			const env = tenantEnv(rawEnv, tenant);
			await runWithTenantEnv(env, () => worker.scheduled(controller, env, ctx));
		}
	},
} satisfies ExportedHandler<CloudflareEnv>;

function stripStamp(body: unknown) {
	if (!body || typeof body !== "object") return body;
	const { [TENANT_QUEUE_FIELD]: _tenant, ...rest } = body as Record<string, unknown>;
	return rest;
}
