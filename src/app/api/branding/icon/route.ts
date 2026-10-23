import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { APP_SETTINGS_ID } from "@/lib/branding/service";
import { getEnvAsync } from "@/lib/cloudflare";
import { getLicenseEntitlements } from "@/lib/licenses/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function getDefaultIcon(env: CloudflareEnv): Promise<Response> {
	const asset = await env.ASSETS.fetch("https://mailflare.local/icon-96.png");
	const headers = new Headers(asset.headers);
	// The asset binding defaults to revalidation; this endpoint uses a versioned URL on changes.
	if (asset.ok) headers.set("Cache-Control", "public, max-age=3600");
	return new Response(asset.body, {
		status: asset.status,
		statusText: asset.statusText,
		headers,
	});
}

export async function GET() {
	const env = await getEnvAsync();
	if (!(await getLicenseEntitlements(env)).canCustomizeBranding) return getDefaultIcon(env);
	try {
		const [settings] = await getDb(env)
			.select({ iconKey: appSettings.iconKey })
			.from(appSettings)
			.where(eq(appSettings.id, APP_SETTINGS_ID))
			.limit(1);
		if (settings?.iconKey) {
			const object = await env.BUCKET.get(settings.iconKey);
			if (object) {
				return new Response(object.body, {
					headers: {
						"Content-Type": object.httpMetadata?.contentType ?? "image/png",
						// Changing the icon bumps the `v` query in this tab; other tabs pick it up within the hour.
						"Cache-Control": "public, max-age=3600",
						"X-Content-Type-Options": "nosniff",
					},
				});
			}
		}
	} catch {
		// Use the packaged icon until the branding migration is available.
	}
	return getDefaultIcon(env);
}
