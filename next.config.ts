import type { NextConfig } from "next";
import { getSecurityHeaders } from "./src/lib/security/headers";

// This file ships in the Docker image next to headers.ts only, so it must not import anything else.

// "node" (self-hosted), "vercel", or undefined (Cloudflare, built by vinext). Vercel sets VERCEL on its builders.
const runtime = process.env.MAILFLARE_RUNTIME || (process.env.VERCEL ? "vercel" : undefined);
const isVercel = runtime === "vercel";

const nextConfig: NextConfig = {
	distDir: runtime === "node" ? ".next-node" : undefined,
	turbopack: {
		root: import.meta.dirname,
		resolveAlias: runtime === "node"
			? { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" }
			: isVercel
				? { "cloudflare:workers": "./server/runtime/cloudflare-workers-vercel.ts" }
				: {},
	},
  allowedDevOrigins: ['mail.dev'],
	typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete
    // even if your project has type errors.
    ignoreBuildErrors: true,
	  },
	// Native and server-only packages used by the self-hosted runtime; never bundle them.
	serverExternalPackages: ["better-sqlite3", "nodemailer", "smtp-server", "ws"],
	env: {
		// Read by browser code: no WebSocket on Vercel, and large uploads go straight to object storage.
		NEXT_PUBLIC_MAILFLARE_REALTIME: isVercel ? "poll" : "",
		NEXT_PUBLIC_MAILFLARE_UPLOADS: isVercel ? "storage" : "",
		...(isVercel ? { MAILFLARE_RUNTIME: "vercel" } : {}),
	},
	async headers() {
		return [
			{
				source: "/(.*)",
				headers: getSecurityHeaders(),
			},
		];
	},
};

if (isVercel) {
	// DAV collection URLs end in a slash; a redirect would break PROPFIND clients.
	nextConfig.skipTrailingSlashRedirect = true;
	nextConfig.rewrites = async () => ({
		beforeFiles: [
			// An mta-sts.<domain> host serves the policy file and nothing else of the app (guardMtaStsHost elsewhere).
			{
				source: "/:path((?!\\.well-known/mta-sts\\.txt$).*)",
				has: [{ type: "host" as const, value: "mta-sts\\..*" }],
				destination: "/api/internal/not-found",
			},
			// CalDAV/CardDAV use PROPFIND and REPORT, which only a Pages Router API route receives.
			{ source: "/dav", destination: "/api/internal/dav?__dav=/dav" },
			{ source: "/dav/:path*", destination: "/api/internal/dav?__dav=/dav/:path*" },
			{ source: "/.well-known/:service(caldav|carddav)", destination: "/api/internal/dav?__dav=/.well-known/:service" },
		],
		afterFiles: [],
		fallback: [],
	});
}

export default nextConfig;
