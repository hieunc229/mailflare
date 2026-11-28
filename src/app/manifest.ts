import type { MetadataRoute } from "next";
import { getHomeBranding } from "./home-server-utils";
import { buildManifest } from "./manifest-utils";

export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
	const branding = await getHomeBranding();
	return buildManifest({ appName: branding.appName, hasCustomIcon: !!branding.hasCustomIcon });
}
