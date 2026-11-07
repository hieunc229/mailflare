import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const EMAIL = "admin@example.com";
const PASSWORD = "demo-password-change-me";
let authenticatorId = "";
/** The authenticator secret of the running enrollment, used to sign a code. */
let totpSecret = "";

/**
 * A fresh instance has no schema yet, so a reset cannot delete or seed the demo
 * account. The setup route applies the bundled migrations; a 403 means an admin
 * already exists, which also means the database is initialized.
 */
async function prepareDatabase(request: APIRequestContext) {
	const response = await request.post("/api/setup/prepare");
	if (response.status() === 403) return;
	const body = await response.json().catch(() => null);
	expect(response.ok(), `POST /api/setup/prepare returned ${response.status()}: ${JSON.stringify(body)}`).toBe(true);
	expect(body?.checks?.every((check: { configured: boolean }) => check.configured)).toBe(true);
	expect(typeof body?.migrated).toBe("boolean");
}

/** Reset and seed the demo account, failing instead of leaving the next test without credentials. */
async function resetDemo(request: APIRequestContext) {
	const response = await request.post("/api/seed?reset=1");
	const body = await response.json().catch(() => null);
	expect(response.ok(), `POST /api/seed?reset=1 returned ${response.status()}: ${JSON.stringify(body)}`).toBe(true);
	expect(body?.ok).toBe(true);
}

test.beforeAll(async ({ request }) => {
	await prepareDatabase(request);
});

test("passkey setup explains when the browser is unsupported", async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
	});
	await page.route("**/api/auth/passkey/setup/context?*", (route) => route.fulfill({
		json: { email: EMAIL, kind: "setup" },
	}));
	await page.goto("/setup/passkey?token=unsupported-browser-test");
	await page.getByRole("button", { name: "Create passkey", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText("This browser does not support passkeys");
});

async function enableVirtualAuthenticator(page: Page): Promise<string> {
	const client = await page.context().newCDPSession(page);
	await client.send("WebAuthn.enable");
	const result = await client.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	authenticatorId = result.authenticatorId;
	return authenticatorId;
}

/** Conditional UI must not auto-complete a password sign-in in the test. */
async function setPresence(page: Page, enabled: boolean) {
	const client = await page.context().newCDPSession(page);
	await client.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled });
}

async function loginWithPassword(page: Page) {
	await setPresence(page, false);
	await page.goto("/login");
	await page.waitForLoadState("networkidle");
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForURL("**/inbox", { timeout: 30_000 });
}

async function logout(page: Page) {
	await page.context().clearCookies();
	await page.evaluate(() => localStorage.clear());
	await page.goto("/login");
}

// Leave the documented demo password usable after the lifecycle test removes it.
test.afterEach(async ({ request }) => {
	await resetDemo(request);
});

/**
 * Sign-in attempts are limited to twenty a minute. The client address is a
 * plain header locally, so every test gets its own budget.
 */
async function isolateRateLimit(page: Page, address: string) {
	await page.context().setExtraHTTPHeaders({ "cf-connecting-ip": address });
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
	const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const char of clean) {
		value = (value << 5) | BASE32.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
}

/** RFC 6238, the same profile the app's authenticator flow expects. */
function totpCode(secret: string): string {
	const counter = Math.floor(Date.now() / 1000 / 30);
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
	const offset = digest[digest.length - 1] & 15;
	const code = ((digest[offset] & 127) << 24) | ((digest[offset + 1] & 255) << 16) | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
	return String(code % 1_000_000).padStart(6, "0");
}

/**
 * Confirms the open step-up dialog. A flow with more than one step keeps the
 * dialog open, so the caller names the title it expects next.
 */
async function completeStepUp(page: Page, options: { title?: string; next?: string } = {}) {
	const title = options.title ?? "Confirm it is you";
	const dialog = page.getByRole("dialog", { name: title });
	await expect(dialog).toBeVisible();
	const passkey = dialog.getByRole("button", { name: "Confirm with a passkey" });
	if (await passkey.count()) {
		await setPresence(page, false);
		await passkey.click();
		await setPresence(page, true);
	} else {
		await dialog.getByLabel("Password").fill(PASSWORD);
		const code = dialog.getByLabel("Code", { exact: true });
		if (await code.count()) await code.fill(totpCode(totpSecret));
		await dialog.getByRole("button", { name: "Continue" }).click();
	}
	if (options.next) await expect(page.getByRole("dialog", { name: options.next })).toBeVisible({ timeout: 30_000 });
	else await expect(dialog).toBeHidden({ timeout: 30_000 });
	await setPresence(page, false);
}

/** Adds the first passkey and answers the follow-up question. */
async function addFirstPasskey(page: Page, choice: string) {
	await page.getByRole("button", { name: "Add a passkey" }).click();
	await page.getByLabel("Passkey name (optional)").fill("Playwright passkey");
	await setPresence(page, true);
	await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
	await completeStepUp(page);
	await expect(page.getByText("Playwright passkey")).toBeVisible({ timeout: 30_000 });
	await setPresence(page, false);
	const dialog = page.getByRole("dialog", { name: "How would you like to sign in?" });
	await expect(dialog).toBeVisible({ timeout: 30_000 });
	await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
	await expect(dialog.getByRole("button", { name: "Not now" })).toHaveCount(0);
	await expect(dialog.getByText("If your chosen option requires a passkey", { exact: false })).toHaveCount(1);
	await expect(dialog.getByRole("button").getByText("If your chosen option requires a passkey", { exact: false })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
	await page.mouse.click(1, 1);
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: choice }).click();
}

/** Enrols an authenticator app so the account has codes to protect. */
async function enrollAuthenticator(page: Page) {
	await page.getByRole("button", { name: "Add authenticator app" }).click();
	await completeStepUp(page);
	const dialog = page.getByRole("dialog", { name: "Scan the code" });
	await expect(dialog).toBeVisible({ timeout: 30_000 });
	totpSecret = ((await dialog.locator("code").first().textContent()) ?? "").trim();
	await dialog.getByLabel("6-digit code").fill(totpCode(totpSecret));
	await dialog.getByRole("button", { name: "Verify and turn on" }).click();
	const codes = page.getByRole("dialog", { name: "Save your recovery codes" });
	await expect(codes).toBeVisible({ timeout: 30_000 });
	await codes.getByRole("button", { name: "Done" }).click();
	await expect(codes).toBeHidden({ timeout: 30_000 });
}

test("passkey lifecycle: add, rename, sign in, second step, password removal", async ({ page, request }) => {
	test.setTimeout(180_000);
	await resetDemo(request);
	await isolateRateLimit(page, "203.0.113.11");
	await enableVirtualAuthenticator(page);
	await setPresence(page, false);

	await loginWithPassword(page);
	await page.goto("/settings/security");

	// The first passkey asks what should happen to password sign-in.
	await addFirstPasskey(page, "Keep my password without a second step");
	await expect(page.getByRole("dialog", { name: "How would you like to sign in?" })).toBeHidden();

	// A check identifies the saved credential without signing in again.
	await page.getByRole("button", { name: "Check a passkey" }).click();
	await setPresence(page, true);
	await expect(page.getByText("Just verified", { exact: true })).toBeVisible({ timeout: 30_000 });
	await setPresence(page, false);

	// The two-step section exposes each method as its own row.
	await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Passkey", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Authenticator app" })).toBeVisible();
	await expect(page.getByText("Lost every passkey?")).toHaveCount(0);

	// Rename the credential without another browser ceremony.
	await page.getByRole("button", { name: "Rename Playwright passkey" }).click();
	await page.getByLabel("Passkey name", { exact: true }).fill("Renamed passkey");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByText("Renamed passkey", { exact: true })).toBeVisible({ timeout: 30_000 });

	// Independent passkey sign-in.
	await logout(page);
	await expect(page.getByText("Can't use your passkey?")).toBeVisible();
	await setPresence(page, false);
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await setPresence(page, true);
	await page.waitForURL("**/inbox", { timeout: 30_000 });
	await setPresence(page, false);

	// Password plus a passkey as the second step.
	await page.goto("/settings/security");
	await page.getByRole("switch", { name: "Require a second step after password sign-in" }).click();
	await completeStepUp(page);
	await expect(page.getByRole("switch", { name: "Require a second step after password sign-in" })).toHaveAttribute("aria-checked", "true");

	// A password alone cannot mint a step-up grant once a second step is required.
	const sessionToken = await page.evaluate(() => localStorage.getItem("mailflare-session-token"));
	const passwordOnlyStepUp = await request.post("/api/auth/step-up", {
		headers: { Authorization: `Bearer ${sessionToken}` },
		data: { password: PASSWORD, action: "passkey.add" },
	});
	expect(passwordOnlyStepUp.status()).toBe(401);

	await logout(page);
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByRole("button", { name: "Use a passkey" })).toBeVisible({ timeout: 30_000 });
	await setPresence(page, false);
	await page.getByRole("button", { name: "Use a passkey" }).click();
	await setPresence(page, true);
	await page.waitForURL("**/inbox", { timeout: 30_000 });
	await setPresence(page, false);

	// Removing the password leaves the passkey as the only way in.
	await page.goto("/settings/security");
	await page.getByRole("button", { name: "Remove password" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Remove password" }).click();
	await completeStepUp(page);
	await expect(page.getByText("Password removed.", { exact: false })).toBeVisible({ timeout: 30_000 });

	// The last passkey is protected without a second confirmation.
	await expect(page.getByRole("button", { name: "Remove Renamed passkey" })).toBeDisabled();

	// Password sign-in no longer works; the passkey still does.
	await logout(page);
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 30_000 });
	await setPresence(page, false);
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await setPresence(page, true);
	await page.waitForURL("**/inbox", { timeout: 30_000 });
	await setPresence(page, false);
});

test("first passkey can make the account passkey-only", async ({ page, request }) => {
	test.setTimeout(180_000);
	await resetDemo(request);
	await isolateRateLimit(page, "203.0.113.12");
	await enableVirtualAuthenticator(page);
	await setPresence(page, false);

	await loginWithPassword(page);
	await page.goto("/settings/security");
	await addFirstPasskey(page, "Use only passkeys");

	// The password goes away, confirmed with the new passkey.
	await completeStepUp(page, { title: "Remove your password?" });
	await expect(page.getByText("This account signs in with passkeys only.")).toBeVisible({ timeout: 30_000 });

	// Password sign-in no longer works; the passkey still does.
	await logout(page);
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 30_000 });
	await setPresence(page, false);
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await setPresence(page, true);
	await page.waitForURL("**/inbox", { timeout: 30_000 });
	await setPresence(page, false);
});

test("turning the authenticator off keeps the two-step policy as it was", async ({ page, request }) => {
	test.setTimeout(180_000);
	await resetDemo(request);
	await isolateRateLimit(page, "203.0.113.14");
	await enableVirtualAuthenticator(page);
	await setPresence(page, false);

	await loginWithPassword(page);
	await page.goto("/settings/security");
	await enrollAuthenticator(page);
	// A passkey is what could take over as the second step.
	await addFirstPasskey(page, "Keep my current sign-in");

	// The user turns the second step off but keeps the authenticator enrolled.
	const toggle = page.getByRole("switch", { name: "Require a second step after password sign-in" });
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await toggle.click();
	await completeStepUp(page);
	await expect(toggle).toHaveAttribute("aria-checked", "false");

	// Removing the authenticator must not switch the second step back on.
	await page.getByRole("button", { name: "Turn off" }).click();
	await completeStepUp(page);
	await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("adding a password chooses its second-factor policy with one passkey scan", async ({ page, request }) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await resetDemo(request);
	await isolateRateLimit(page, "203.0.113.15");
	await enableVirtualAuthenticator(page);
	await setPresence(page, false);
	await loginWithPassword(page);
	await page.goto("/settings/security");
	await addFirstPasskey(page, "Use only passkeys");
	await completeStepUp(page, { title: "Remove your password?" });
	await expect(page.getByLabel("New password", { exact: true })).toBeVisible();

	let scans = 0;
	let saves = 0;
	page.on("request", (request) => {
		if (request.method() !== "POST") return;
		if (new URL(request.url()).pathname === "/api/auth/step-up/verify") scans++;
		if (new URL(request.url()).pathname === "/api/settings/password") saves++;
	});
	const dialog = page.getByRole("dialog", { name: "How would you like to sign in?" });
	async function startPassword() {
		await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
		await page.getByLabel("Confirm new password", { exact: true }).fill(PASSWORD);
		await page.getByRole("button", { name: "Set password", exact: true }).click();
		await completeStepUp(page);
		await expect(dialog).toBeVisible();
	}

	await startPassword();
	expect(scans).toBe(1);
	expect(saves).toBe(0);
	const bounds = await dialog.boundingBox();
	if (!bounds) throw new Error("Password policy dialog has no bounds");
	expect(bounds.x).toBeGreaterThanOrEqual(0);
	expect(bounds.y).toBeGreaterThanOrEqual(0);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
	await page.screenshot({ path: test.info().outputPath("password-policy-mobile.png"), animations: "disabled" });
	const sessionToken = await page.evaluate(() => localStorage.getItem("mailflare-session-token"));
	const unverified = await request.post("/api/settings/password", {
		headers: { Authorization: `Bearer ${sessionToken}` },
		data: { newPassword: PASSWORD, stepUpToken: "invalid-proof", requireSecondFactor: false },
	});
	expect(unverified.status()).toBe(401);
	await dialog.getByRole("button", { name: "Keep using only passkeys" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
	expect(saves).toBe(0);

	await startPassword();
	await dialog.getByRole("button", { name: "Use a passkey as your second factor" }).click();
	await expect(dialog).toBeHidden({ timeout: 30_000 });
	const toggle = page.getByRole("switch", { name: "Require a second step after password sign-in" });
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	expect(scans).toBe(2);
	expect(saves).toBe(1);

	await page.getByRole("button", { name: "Remove password", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Remove password", exact: true }).click();
	await completeStepUp(page);
	await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
	const before = scans;
	await startPassword();
	await dialog.getByRole("button", { name: "Keep my password without a second step" }).click();
	await expect(dialog).toBeHidden({ timeout: 30_000 });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	expect(scans).toBe(before + 1);
	expect(saves).toBe(2);
	await logout(page);
	await loginWithPassword(page);
});

test("removing the last passkey warns and disables its second-factor requirement", async ({ page, request }) => {
	test.setTimeout(180_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await resetDemo(request);
	await isolateRateLimit(page, "203.0.113.16");
	await enableVirtualAuthenticator(page);
	await setPresence(page, false);
	await loginWithPassword(page);
	await page.goto("/settings/security");
	await addFirstPasskey(page, "Use a passkey as your second factor");
	await completeStepUp(page, { title: "Require a second step after password sign-in" });
	const toggle = page.getByRole("switch", { name: "Require a second step after password sign-in" });
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await page.getByRole("button", { name: "Remove Playwright passkey", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Remove this passkey?" });
	await expect(dialog.getByText("Removing your last passkey will also turn off two-step verification. You’ll sign in with your password only.")).toBeVisible();
	const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
	await expect(cancel).toBeFocused();
	const cancelBounds = await cancel.boundingBox();
	const removeBounds = await dialog.getByRole("button", { name: "Remove", exact: true }).boundingBox();
	if (!cancelBounds || !removeBounds) throw new Error("Removal dialog buttons have no bounds");
	expect(removeBounds.x).toBeGreaterThan(cancelBounds.x + cancelBounds.width);
	expect(Math.abs(removeBounds.y - cancelBounds.y)).toBeLessThan(2);
	await cancel.click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("Playwright passkey", { exact: true })).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await page.getByRole("button", { name: "Remove Playwright passkey", exact: true }).click();
	const sessionToken = await page.evaluate(() => localStorage.getItem("mailflare-session-token"));
	const passkeysResponse = await request.get("/api/settings/security", {
		headers: { Authorization: `Bearer ${sessionToken}` },
	});
	expect(passkeysResponse.ok()).toBe(true);
	const security = await passkeysResponse.json();
	const unverified = await request.delete(`/api/settings/passkeys/${security.passkeys[0].id}`, {
		headers: { Authorization: `Bearer ${sessionToken}` },
		data: { stepUpToken: "invalid-proof" },
	});
	expect(unverified.status()).toBe(401);
	const unchanged = await request.get("/api/settings/security", {
		headers: { Authorization: `Bearer ${sessionToken}` },
	});
	const unchangedSecurity = await unchanged.json();
	expect(unchangedSecurity.requireSecondFactor).toBe(true);
	expect(unchangedSecurity.passkeys).toHaveLength(1);
	await dialog.getByRole("button", { name: "Remove", exact: true }).click();
	await completeStepUp(page);
	await expect(page.getByText("Playwright passkey", { exact: true })).toHaveCount(0);
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await logout(page);
	await loginWithPassword(page);
});

test("removing the last passkey preserves authenticator two-step verification", async ({ page, request }) => {
	test.setTimeout(180_000);
	await resetDemo(request);
	await isolateRateLimit(page, "203.0.113.17");
	await enableVirtualAuthenticator(page);
	await setPresence(page, false);
	await loginWithPassword(page);
	await page.goto("/settings/security");
	await enrollAuthenticator(page);
	await addFirstPasskey(page, "Keep my current sign-in");
	await page.getByRole("button", { name: "Remove Playwright passkey", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Remove this passkey?" });
	await expect(dialog.getByText("Removing your last passkey", { exact: false })).toHaveCount(0);
	await dialog.getByRole("button", { name: "Remove", exact: true }).click();
	await completeStepUp(page);
	await expect(page.getByText("Playwright passkey", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("switch", { name: "Require a second step after password sign-in" })).toHaveAttribute("aria-checked", "true");
	await logout(page);
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.getByLabel("Authenticator code or recovery code", { exact: true }).fill(totpCode(totpSecret));
	await page.getByRole("button", { name: "Verify", exact: true }).click();
	await page.waitForURL("**/inbox", { timeout: 30_000 });
});

test("first passkey removes the password and the authenticator codes together", async ({ page, request }) => {
	test.setTimeout(180_000);
	await resetDemo(request);
	await isolateRateLimit(page, "203.0.113.13");
	await enableVirtualAuthenticator(page);
	await setPresence(page, false);

	await loginWithPassword(page);
	await page.goto("/settings/security");
	await enrollAuthenticator(page);

	await addFirstPasskey(page, "Use only passkeys");
	// With codes in place the choice drops the password-plus-passkey option.
	await expect(page.getByRole("dialog", { name: "How would you like to sign in?" })).toBeHidden();

	// The authenticator goes first, then the password.
	await completeStepUp(page, { title: "Turn off authenticator codes", next: "Remove your password?" });
	await completeStepUp(page, { title: "Remove your password?" });
	await expect(page.getByText("This account signs in with passkeys only.")).toBeVisible({ timeout: 30_000 });

	// The authenticator app is gone too.
	await expect(page.getByRole("heading", { name: "Authenticator app" })).toHaveCount(0);

	await logout(page);
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByText("Invalid email or password.")).toBeVisible({ timeout: 30_000 });
	await setPresence(page, false);
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await setPresence(page, true);
	await page.waitForURL("**/inbox", { timeout: 30_000 });
	await setPresence(page, false);
});
