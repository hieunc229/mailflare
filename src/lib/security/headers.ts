// Dev tooling (HMR, source maps) evaluates strings; production never needs to.
const scriptEval = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";

const csp = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${scriptEval} https://challenges.cloudflare.com`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self' data:",
	"connect-src 'self' ws: wss: https://challenges.cloudflare.com",
	// 'self' lets the Drive preview show PDFs and text files in an iframe.
	"frame-src 'self' https://challenges.cloudflare.com",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'self'",
	"upgrade-insecure-requests",
].join("; ");

export function getSecurityHeaders() {
	return [
		{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },
		{ key: "Content-Security-Policy", value: csp },
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
