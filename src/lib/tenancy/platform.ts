/**
 * A workspace never holds the platform's SMTP2GO key. In production it reaches SMTP2GO through the cloud app over the
 * `CLOUD` service binding (see smtp2go.ts), and `getPlatformSmtp2goKey` returns a placeholder that says so.
 * Without the binding (local dev) it falls back to a `SMTP2GO_API_KEY` secret on this Worker.
 */
export const CLOUD_PROXY = "via-cloud-app";

let cloud: CloudflareEnv["CLOUD"];

/** The binding behind the placeholder key; the same for every request, so remembering it here is safe. */
export const getCloudBinding = () => cloud;

export async function getPlatformSmtp2goKey(env: CloudflareEnv): Promise<string | null> {
	if (env.CLOUD) {
		cloud = env.CLOUD;
		return CLOUD_PROXY;
	}
	return (env as { SMTP2GO_API_KEY?: string }).SMTP2GO_API_KEY?.trim() || null;
}
