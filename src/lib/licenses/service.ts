// Varunya Mail: Native platform policy replacing Paymug commercial license checks.
// Preserves the licenseSettings table and database schema for compatibility.
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { licenseSettings } from "@/db/schema";
import type { LicenseEntitlements, LicensePlan, LicenseStatus } from "./types";
import { parseFeatures } from "./utils";

const LICENSE_SETTINGS_ID = "default";

const VARUNYA_DEFAULT_FEATURES = ["branding", "accounts", "sharing", "forwarding"];

async function getOrCreateLicenseSettings(env: CloudflareEnv) {
	const db = getDb(env);
	const [existing] = await db
		.select()
		.from(licenseSettings)
		.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID))
		.limit(1);
	if (existing) return existing;

	const now = new Date();
	await db
		.insert(licenseSettings)
		.values({
			id: LICENSE_SETTINGS_ID,
			instanceId: crypto.randomUUID(),
			plan: "team",
			state: "active",
			features: JSON.stringify(VARUNYA_DEFAULT_FEATURES),
			seatLimit: null,
			activatedAt: now,
			validatedAt: now,
		})
		.onConflictDoNothing({ target: licenseSettings.id });

	const [settings] = await db
		.select()
		.from(licenseSettings)
		.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID))
		.limit(1);
	if (!settings) throw new Error("Unable to initialize license settings");
	return settings;
}

function toLicenseStatus(settings: typeof licenseSettings.$inferSelect): LicenseStatus {
	return {
		plan: "team",
		state: "active",
		features: parseFeatures(settings.features).length ? parseFeatures(settings.features) : VARUNYA_DEFAULT_FEATURES,
		seatLimit: null,
		instanceId: settings.instanceId,
		instanceUrl: settings.instanceUrl,
		active: true,
		activatedAt: settings.activatedAt ?? new Date(),
		validatedAt: settings.validatedAt ?? new Date(),
	};
}

export async function getLicenseStatus(env: CloudflareEnv): Promise<LicenseStatus> {
	return toLicenseStatus(await getOrCreateLicenseSettings(env));
}

export async function getLicenseEntitlements(_env: CloudflareEnv): Promise<LicenseEntitlements> {
	// Native Varunya feature policy: full collaboration capabilities unlocked.
	return {
		plan: "team",
		canCustomizeBranding: true,
		canManageAccounts: true,
		canShareMailboxes: true,
		accountSeatLimit: null,
		canForwardEmail: true,
	};
}

export async function activateLicense(
	env: CloudflareEnv,
	_licenseKey: string,
	instanceUrl: string,
	_plan: Exclude<LicensePlan, "community">,
): Promise<LicenseStatus> {
	const settings = await getOrCreateLicenseSettings(env);
	const now = new Date();
	await getDb(env)
		.update(licenseSettings)
		.set({
			instanceUrl,
			plan: "team",
			state: "active",
			features: JSON.stringify(VARUNYA_DEFAULT_FEATURES),
			seatLimit: null,
			activatedAt: now,
			validatedAt: now,
			updatedAt: now,
		})
		.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID));
	return getLicenseStatus(env);
}

export async function validateLicense(env: CloudflareEnv, _licenseKey: string, _instanceUrl: string): Promise<LicenseStatus> {
	return getLicenseStatus(env);
}

export async function deactivateLicense(env: CloudflareEnv): Promise<LicenseStatus> {
	return getLicenseStatus(env);
}

