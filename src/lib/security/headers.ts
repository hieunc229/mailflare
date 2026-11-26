// Dev tooling (HMR, source maps) evaluates strings; production never needs to.
const scriptEval = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";

const policy = (uploadSources: string[]) => [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${scriptEval} https://challenges.cloudflare.com`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self' data:",
	["connect-src 'self' ws: wss: https://challenges.cloudflare.com", ...uploadSources].join(" "),
	// 'self' lets the Drive preview show PDFs and text files in an iframe.
	"frame-src 'self' https://challenges.cloudflare.com",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'self'",
	"upgrade-insecure-requests",
].join("; ");

/** `uploadSources`: where the browser may also send large uploads (Vercel only; see next.config.ts). */
export function getSecurityHeaders(uploadSources: string[] = []) {
	return [
		{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },
		{ key: "Content-Security-Policy", value: policy(uploadSources) },
		{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
		{ key: "X-Content-Type-Options", value: "nosniff" },
		{ key: "X-Frame-Options", value: "SAMEORIGIN" },
		// No window the app opens or that opens the app keeps a reference to it.
		{ key: "Cross-Origin-Opener-Policy", value: "same-origin" },
		{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
		{
			key: "Permissions-Policy",
			value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
		},
	];
}
