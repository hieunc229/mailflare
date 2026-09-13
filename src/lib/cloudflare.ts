import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getNodeEnv } from "@/lib/runtime";

export function getEnv(): CloudflareEnv {
	return getNodeEnv() ?? (getCloudflareContext().env as CloudflareEnv);
}

export async function getEnvAsync(): Promise<CloudflareEnv> {
	return getNodeEnv() ?? ((await getCloudflareContext({ async: true })).env as CloudflareEnv);
}
