/**
 * In a multi-tenant deployment the platform operator owns what a self-hosted admin would configure:
 * updates and migrations (one deploy upgrades every workspace), licenses (workspaces get Team features
 * from their plan), backups and the mail provider's account keys.
 */
const BLOCKED_API = [
	"/api/licenses",
	"/api/backups",
	"/api/admin/update",
	"/api/admin/migrations",
	"/api/admin/resend-key",
	"/api/admin/aws",
];
const BLOCKED_PAGES = ["/licenses", "/backups"];
// A hosted workspace already has its administrator: first-run setup and registration never exist.
const SETUP_API = ["/api/setup", "/api/auth/register"];
const SETUP_PAGES = ["/setup", "/register", "/onboarding"];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function managedRouteResponse(request: Request, url: URL): Response | null {
	if (SETUP_API.some((prefix) => under(url.pathname, prefix))) return Response.json({ error: "Not available" }, { status: 404 });
	if (SETUP_PAGES.some((prefix) => under(url.pathname, prefix))) return Response.redirect(new URL("/login", url).toString(), 302);
	if (BLOCKED_API.some((prefix) => under(url.pathname, prefix))) {
		return Response.json({ error: "Managed by your workspace plan" }, { status: 403 });
	}
	if (request.method === "GET" && BLOCKED_PAGES.some((prefix) => under(url.pathname, prefix))) {
		return Response.redirect(new URL("/admin", url).toString(), 302);
	}
	return null;
}
