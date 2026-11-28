import type { MetadataRoute } from "next";

/** The web app manifest; an uploaded brand icon replaces the stock icons (its size and type are unknown, so no maskable entry). */
export function buildManifest(branding: { appName: string; hasCustomIcon: boolean }): MetadataRoute.Manifest {
	return {
		name: branding.appName,
		short_name: branding.appName,
		description: "Email, anywhere.",
		id: "/",
		scope: "/",
		start_url: "/inbox",
		display: "standalone",
		background_color: "#ffffff",
		theme_color: "#f6f8fc",
		icons: branding.hasCustomIcon
			? [{ src: "/api/branding/icon", sizes: "192x192 512x512", purpose: "any" }]
			: [
				{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
				{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
				{ src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
			],
	};
}
