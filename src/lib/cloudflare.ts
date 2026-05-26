import { getCloudflareContext } from "@opennextjs/cloudflare";

export function getEnv(): CloudflareEnv {
	return getCloudflareContext().env as CloudflareEnv;
}
