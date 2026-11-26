/**
 * The cloud app shows each workspace's icon in its own pages (dashboard, menus). It needs to know whether the
 * workspace has a custom icon at all, and when it last changed (to bypass the icon's one-hour browser cache).
 * `workspaces.icon_version` holds that: null = no custom icon, else the time of the last change.
 */
const checked = new Set<string>();

export async function markCustomIcon(env: CloudflareEnv, onlyIfUnset: boolean): Promise<void> {
	const tenant = env.MAILFLARE_TENANT;
	if (!tenant || !env.CONTROL) return;
	// getBranding runs on most requests: the backfill (onlyIfUnset) needs one control-plane write per isolate, not one per request.
	if (onlyIfUnset) {
		if (checked.has(tenant.id)) return;
		checked.add(tenant.id);
	}
	try {
		await env.CONTROL.prepare(`UPDATE workspaces SET icon_version = ? WHERE id = ?${onlyIfUnset ? " AND icon_version IS NULL" : ""}`)
			.bind(Math.floor(Date.now() / 1000), tenant.id).run();
	} catch {
		// Older control plane without the column: the cloud app just keeps showing the letter icon.
	}
}
