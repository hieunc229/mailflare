const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/**
 * The page behind an unsubscribe link: a small standalone HTML document for people outside the app
 * (no session, no catalog). It must not be framed, cached, indexed or leak its URL (the token) in a Referer.
 */
export function unsubscribePage(input: { status: number; title: string; message: string; action?: { path: string; label: string } }): Response {
	const form = input.action
		? `<form method="post" action="${escapeHtml(input.action.path)}"><button type="submit">${escapeHtml(input.action.label)}</button></form>`
		: "";
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(input.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#f5f5f5;color:#171717}main{max-width:28rem;margin:1rem;padding:2rem;background:#fff;border-radius:1rem}h1{font-size:1.25rem;margin:0 0 .75rem}button{min-height:44px;padding:0 1.25rem;border:0;border-radius:.5rem;background:#1d4ed8;color:#fff;font:inherit;cursor:pointer}p{word-break:break-word}</style></head><body><main><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${form}</main></body></html>`;
	return new Response(html, {
		status: input.status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
			"x-frame-options": "DENY",
			"x-robots-tag": "noindex, nofollow",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}
