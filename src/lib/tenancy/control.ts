/**
 * Domains are unique across the whole deployment: inbound mail is routed to the one workspace that owns the
 * recipient domain. A workspace claims a domain in the control plane before it adds it.
 */
export async function claimTenantDomain(env: CloudflareEnv, hostname: string): Promise<void> {
	const tenant = env.MAILFLARE_TENANT;
	if (!tenant || !env.CONTROL) return;
	await env.CONTROL.prepare("INSERT OR IGNORE INTO domains (domain, workspace_id, created_at) VALUES (?, ?, ?)")
		.bind(hostname, tenant.id, Math.floor(Date.now() / 1000))
		.run();
	const owner = await env.CONTROL.prepare("SELECT workspace_id FROM domains WHERE domain = ?").bind(hostname).first<{ workspace_id: string }>();
	if (owner?.workspace_id !== tenant.id) throw new Error("Domain is already registered");
}

/**
 * True when another workspace holds the claim: a domain released from an unused trial and then taken by someone else
 * must no longer be usable by the old workspace.
 */
export async function isClaimedElsewhere(env: CloudflareEnv, hostname: string): Promise<boolean> {
	const tenant = env.MAILFLARE_TENANT;
	if (!tenant || !env.CONTROL) return false;
	const owner = await env.CONTROL.prepare("SELECT workspace_id FROM domains WHERE domain = ?").bind(hostname).first<{ workspace_id: string }>();
	return !!owner && owner.workspace_id !== tenant.id;
}

export async function releaseTenantDomain(env: CloudflareEnv, hostname: string): Promise<void> {
	const tenant = env.MAILFLARE_TENANT;
	if (!tenant || !env.CONTROL) return;
	await env.CONTROL.prepare("DELETE FROM domains WHERE domain = ? AND workspace_id = ?").bind(hostname, tenant.id).run();
}
