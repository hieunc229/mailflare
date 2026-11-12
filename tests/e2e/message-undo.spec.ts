import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";

const EMAIL = "admin@example.com";
const PASSWORD = "demo-password-change-me";

async function prepareDatabase(request: APIRequestContext) {
	const response = await request.post("/api/setup/prepare");
	// A configured installation answers 403. A local dev server without
	// Cloudflare API credentials answers 503 even after the D1 migrations have
	// been applied; the seed call below still proves the schema is usable.
	if (response.status() === 403 || response.status() === 503) return;
	const body = await response.json().catch(() => null);
	expect(response.ok(), `POST /api/setup/prepare returned ${response.status()}: ${JSON.stringify(body)}`).toBe(true);
}

async function resetDemo(request: APIRequestContext) {
	const response = await request.post("/api/seed?reset=1");
	const body = await response.json().catch(() => null);
	expect(response.ok(), `POST /api/seed?reset=1 returned ${response.status()}: ${JSON.stringify(body)}`).toBe(true);
}

async function login(page: Page) {
	await page.goto("/login");
	await page.waitForLoadState("networkidle");
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForURL("**/inbox", { timeout: 30_000 });
}

test.beforeAll(async ({ request }) => {
	await prepareDatabase(request);
});

test.afterEach(async ({ request }) => {
	await resetDemo(request);
});

/**
 * Regression: explicit row read/unread must show its applied state in the row,
 * and Undo must restore the row optimistically while the undo request is still
 * unresolved. A background list refetch during that window must not paint the
 * server's pre-undo value back over it.
 */
test("row read undo is optimistic while the undo request is pending", async ({ page }) => {
	await resetDemo(page.request);
	await login(page);
	await page.goto("/inbox");

	const initialRow = page.locator('[role="listitem"]').filter({
		has: page.getByRole("button", { name: "Mark as unread" }),
	}).first();
	await expect(initialRow).toBeVisible();
	const href = await initialRow.locator('a[href^="/inbox/"]').first().getAttribute("href");
	expect(href).toBeTruthy();
	const row = page.locator('[role="listitem"]').filter({ has: page.locator(`a[href="${href}"]`) }).first();
	await row.hover();
	await row.getByRole("button", { name: "Mark as unread" }).click();

	// The action settled: the row is unread locally and the toast is available.
	await expect(row.getByRole("button", { name: "Mark as read" })).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

	let resolveHeld: (route: Route) => void;
	const held = new Promise<Route>((resolve) => { resolveHeld = resolve; });
	await page.route("**/api/messages/actions", async (route) => {
		const body = route.request().postDataJSON();
		if (body?.op === "undo") {
			resolveHeld(route);
			return;
		}
		await route.continue();
	});

	try {
		await page.getByRole("button", { name: "Undo" }).click();
		// The request is deliberately unresolved. The row must already be read
		// again, which is the exact state the old implementation lost.
		await expect(row.getByRole("button", { name: "Mark as unread" })).toHaveCount(1, { timeout: 5_000 });
	} finally {
		const route = await Promise.race<Route | null>([held, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
		if (route) await route.continue().catch(() => undefined);
	}

	// Once the server confirms, the refetch keeps the same restored value.
	await expect(row.getByRole("button", { name: "Mark as unread" })).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});
